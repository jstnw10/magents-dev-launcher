import Foundation
import Observation

@MainActor
@Observable
final class ChatViewModel {
    var messages: [ConversationMessage] = []
    var inputText: String = ""
    var isLoading: Bool = false
    var error: String?

    /// Streaming parts indexed by part ID, built up during SSE streaming.
    var streamingParts: [String: MessagePart] = [:]
    /// Ordered part IDs to maintain insertion order during streaming.
    var streamingPartOrder: [String] = []

    /// Derived display text from streaming parts (concatenates text from text/reasoning parts).
    var streamingText: String {
        streamingPartOrder.compactMap { partId -> String? in
            guard let part = streamingParts[partId] else { return nil }
            switch part.type {
            case .text, .reasoning:
                return part.text
            default:
                return nil
            }
        }.joined()
    }

    let agentId: String
    let sessionId: String
    let workspacePath: String

    /// The system prompt to send as a synthetic part on every message, if any.
    private let systemPrompt: String?

    private var assistantMessageId: String?
    private weak var workspaceViewModel: WorkspaceViewModel?

    init(agentId: String, sessionId: String, workspacePath: String, workspaceViewModel: WorkspaceViewModel, agentMetadata: AgentMetadata? = nil) {
        self.agentId = agentId
        self.sessionId = sessionId
        self.workspacePath = workspacePath
        self.workspaceViewModel = workspaceViewModel

        // Use PromptTemplateManager to get the full prompt template with specialist role injected
        if let agent = agentMetadata {
            self.systemPrompt = PromptTemplateManager().getPrompt(for: agent, workspacePath: workspacePath)
        } else {
            self.systemPrompt = nil
        }
    }

    // MARK: - Event Registration (Workspace-Level SSE)

    /// Register to receive SSE events routed from the workspace-level connection.
    func registerForEvents() {
        workspaceViewModel?.registerEventHandler(sessionId: sessionId) { [weak self] event in
            await self?.handleSSEEvent(event)
        }
    }

    /// Unregister from receiving SSE events (tab closed, but SSE stays connected).
    func unregisterForEvents() {
        workspaceViewModel?.unregisterEventHandler(sessionId: sessionId)
    }

    /// Handle an SSE event routed from the workspace-level connection.
    private func handleSSEEvent(_ event: SSEEvent) async {
        guard let jsonData = event.data.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any]
        else { return }

        let eventType = json["type"] as? String ?? ""
        let properties = json["properties"] as? [String: Any] ?? [:]

        // Extract message ID from event properties
        let msgId = properties["messageID"] as? String
            ?? (properties["info"] as? [String: Any])?["id"] as? String
            ?? (properties["part"] as? [String: Any])?["messageID"] as? String

        // Extract role from event properties
        let role = (properties["info"] as? [String: Any])?["role"] as? String

        print("[ChatVM] SSE: type=\(eventType) role=\(role ?? "nil") msgId=\(msgId ?? "nil")")

        switch eventType {
        case "message.updated":
            if let info = properties["info"] as? [String: Any],
               let messageRole = info["role"] as? String,
               let messageId = info["id"] as? String {
                if messageRole == "assistant" {
                    self.assistantMessageId = messageId
                    print("[ChatVM] SSE: tracking assistant messageId=\(messageId)")
                }
                // Finalize when assistant message has completed time
                if messageRole == "assistant",
                   let time = info["time"] as? [String: Any],
                   time["completed"] != nil {
                    self.finalizeStreamingMessage()
                }
            }

        case "message.part.delta":
            guard let assistantId = self.assistantMessageId else {
                print("[ChatVM] SSE: skipping delta, no assistant message identified yet")
                break
            }
            if let deltaMsgId = properties["messageID"] as? String,
               deltaMsgId != assistantId {
                break
            }
            if let partID = properties["partID"] as? String,
               let field = properties["field"] as? String,
               let delta = properties["delta"] as? String {
                if var part = self.streamingParts[partID] {
                    switch field {
                    case "text":
                        part.text = (part.text ?? "") + delta
                    default:
                        print("[ChatVM] SSE: unknown delta field '\(field)'")
                    }
                    self.streamingParts[partID] = part
                } else {
                    let newPart = MessagePart(
                        id: partID,
                        messageID: assistantId,
                        type: .text,
                        text: field == "text" ? delta : nil
                    )
                    self.streamingParts[partID] = newPart
                    self.streamingPartOrder.append(partID)
                }
            }

        case "message.part.updated":
            guard let assistantId = self.assistantMessageId else {
                break
            }
            guard let partDict = properties["part"] as? [String: Any] else { break }
            let partMsgId = partDict["messageID"] as? String
            if let partMsgId = partMsgId, partMsgId != assistantId {
                break
            }
            guard let partID = partDict["id"] as? String,
                  let typeStr = partDict["type"] as? String else { break }

            let partType = MessagePartType(rawValue: typeStr) ?? .text
            var part = self.streamingParts[partID] ?? MessagePart(
                id: partID,
                messageID: partMsgId ?? assistantId,
                type: partType
            )

            if let text = partDict["text"] as? String {
                part.text = text
            }

            if partType == .tool {
                part.toolName = partDict["tool"] as? String
                part.toolCallID = partDict["callID"] as? String
                if let state = partDict["state"] as? [String: Any] {
                    if let statusStr = state["status"] as? String {
                        part.toolStatus = ToolStatus(rawValue: statusStr)
                    }
                    part.toolTitle = state["title"] as? String
                    part.toolOutput = state["output"] as? String
                    if let input = state["input"] {
                        part.toolInput = stringifyJSON(input)
                    }
                }
            }

            self.streamingParts[partID] = part
            if !self.streamingPartOrder.contains(partID) {
                self.streamingPartOrder.append(partID)
            }

        case "session.idle":
            // Don't break the connection — just mark loading as done
            self.isLoading = false

        case "server.heartbeat", "server.connected", "file.watcher.updated",
             "session.updated", "session.diff", "session.status",
             "todo.updated":
            break

        default:
            print("[ChatVM] SSE event: \(eventType)")
        }
    }

    /// Finalize the current streaming message into a completed ConversationMessage.
    private func finalizeStreamingMessage() {
        guard !streamingParts.isEmpty else { return }
        let finalParts = streamingPartOrder.compactMap { streamingParts[$0] }
        let finalText = streamingText.isEmpty ? "(No response received)" : streamingText
        let assistantMessage = ConversationMessage(
            role: .assistant,
            content: finalText,
            parts: finalParts,
            timestamp: ISO8601DateFormatter().string(from: Date()),
            tokens: nil,
            cost: nil
        )
        messages.append(assistantMessage)
        streamingParts = [:]
        streamingPartOrder = []
        assistantMessageId = nil
        isLoading = false
    }

    // MARK: - Load Conversation from Server

    func loadConversation(serverManager: ServerManager) async {
        do {
            let serverInfo = try await serverManager.getOrStart(workspacePath: workspacePath)
            let client = OpenCodeClient(serverInfo: serverInfo)
            let serverMessages = try await client.getMessages(sessionId: sessionId)

            // Convert server messages to ConversationMessage with full part data
            messages = serverMessages.compactMap { msg -> ConversationMessage? in
                let role: MessageRole = msg.info.role == "user" ? .user : .assistant
                let messageParts = Self.convertPromptParts(msg.parts, messageID: msg.info.id)
                let textContent = msg.parts.compactMap { $0.text }.joined(separator: "\n")

                // Skip messages with no text content and no tool parts
                let hasToolParts = messageParts.contains { $0.type == .tool }
                guard !textContent.isEmpty || hasToolParts else { return nil }

                return ConversationMessage(
                    role: role,
                    content: textContent,
                    parts: messageParts,
                    timestamp: msg.info.time?.created.map {
                        ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: $0 / 1000))
                    } ?? ISO8601DateFormatter().string(from: Date()),
                    tokens: nil,
                    cost: nil
                )
            }
        } catch {
            print("[ChatVM] Failed to load conversation from server: \(error)")
            messages = []
        }
    }

    // MARK: - Send Message (prompt only — response comes via persistent SSE connection)

    func sendMessage(serverManager: ServerManager) async {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        let userMessage = ConversationMessage(
            role: .user,
            content: text,
            parts: [],
            timestamp: ISO8601DateFormatter().string(from: Date()),
            tokens: nil,
            cost: nil
        )
        messages.append(userMessage)
        inputText = ""
        isLoading = true
        streamingParts = [:]
        streamingPartOrder = []
        assistantMessageId = nil
        error = nil

        do {
            let serverInfo = try await serverManager.getOrStart(workspacePath: workspacePath)
            let client = OpenCodeClient(serverInfo: serverInfo)
            // Send systemPrompt as a synthetic part on every message (Intent/ACP pattern)
            try await client.sendPromptFireAndForget(sessionId: sessionId, text: text, systemPrompt: systemPrompt)
            // Response will arrive via the persistent SSE connection
        } catch {
            self.error = error.localizedDescription
            isLoading = false
        }
    }

    // MARK: - Cancel Streaming

    func cancelStreaming() {
        // Note: Don't disconnect SSE — it's persistent. Just finalize the current streaming state.
        if !streamingParts.isEmpty {
            let finalParts = streamingPartOrder.compactMap { streamingParts[$0] }
            let assistantMessage = ConversationMessage(
                role: .assistant,
                content: streamingText,
                parts: finalParts,
                timestamp: ISO8601DateFormatter().string(from: Date()),
                tokens: nil,
                cost: nil
            )
            messages.append(assistantMessage)
            streamingParts = [:]
            streamingPartOrder = []
        }
        isLoading = false
    }

    // MARK: - Helpers

    /// Convert server PromptPart array to MessagePart array.
    static func convertPromptParts(_ promptParts: [PromptPart], messageID: String) -> [MessagePart] {
        return promptParts.compactMap { pp -> MessagePart? in
            guard let partType = MessagePartType(rawValue: pp.type) else { return nil }
            var part = MessagePart(
                id: pp.id ?? UUID().uuidString,
                messageID: pp.messageID ?? messageID,
                type: partType,
                text: pp.text
            )
            if partType == .tool {
                part.toolName = pp.tool
                part.toolCallID = pp.callID
                if let state = pp.state {
                    if let statusStr = state.status {
                        part.toolStatus = ToolStatus(rawValue: statusStr)
                    }
                    part.toolTitle = state.title
                    part.toolOutput = state.output
                    if let input = state.input {
                        part.toolInput = stringifyJSON(input.value)
                    }
                }
            }
            return part
        }
    }
}

/// Convert any JSON-compatible value to a string representation.
private func stringifyJSON(_ value: Any) -> String? {
    if let str = value as? String { return str }
    guard JSONSerialization.isValidJSONObject(value) else { return "\(value)" }
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
          let str = String(data: data, encoding: .utf8) else { return nil }
    return str
}

