import Foundation
import Observation

@MainActor
@Observable
final class ChatViewModel {
    var messages: [ConversationMessage] = []
    var inputText: String = ""
    var isLoading: Bool = false
    var error: String?

    /// Streaming parts indexed by part ID, built up during WebSocket streaming.
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

    private var assistantMessageId: String?
    private var agentManagerClient: AgentManagerClient?
    private var webSocketTask: Task<Void, Never>?
    private var loadingTimeoutTask: Task<Void, Never>?

    /// Timeout duration in seconds before loading state is cleared with an error.
    private let loadingTimeoutSeconds: UInt64 = 60

    init(agentId: String, sessionId: String, workspacePath: String) {
        self.agentId = agentId
        self.sessionId = sessionId
        self.workspacePath = workspacePath
    }

    // MARK: - WebSocket Connection

    /// Connect to the agent-manager WebSocket for this agent.
    func connectWebSocket(serverManager: ServerManager) async {
        guard let baseURL = serverManager.agentManagerURL(for: workspacePath) else {
            print("[ChatVM] No agent-manager URL available for \(workspacePath)")
            return
        }

        let client = AgentManagerClient(baseURL: baseURL)
        self.agentManagerClient = client
        let frameStream = client.connect(agentId: agentId)

        webSocketTask = Task { [weak self] in
            for await frame in frameStream {
                guard let self else { break }
                guard !Task.isCancelled else { break }
                await self.handleFrame(frame)
            }
            // Stream ended (WebSocket disconnected) — clean up loading state
            guard let self else { return }
            if self.isLoading {
                if !self.streamingParts.isEmpty {
                    self.finalizeStreamingMessage()
                }
                self.isLoading = false
            }
        }

        print("[ChatVM] WebSocket connected for agent \(agentId)")
    }

    /// Disconnect the WebSocket.
    func disconnectWebSocket() {
        cancelLoadingTimeout()
        webSocketTask?.cancel()
        webSocketTask = nil
        agentManagerClient?.disconnect()
        agentManagerClient = nil
        print("[ChatVM] WebSocket disconnected for agent \(agentId)")
    }

    // MARK: - Loading Timeout

    /// Start (or restart) the loading timeout timer.
    /// If no streaming activity arrives within `loadingTimeoutSeconds`, loading is cleared with an error.
    private func startLoadingTimeout() {
        cancelLoadingTimeout()
        loadingTimeoutTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(nanoseconds: self.loadingTimeoutSeconds * 1_000_000_000)
            } catch {
                return // Task was cancelled
            }
            guard !Task.isCancelled else { return }
            // Timeout fired — clear loading state and show error
            if self.isLoading {
                if !self.streamingParts.isEmpty {
                    self.finalizeStreamingMessage()
                }
                self.isLoading = false
                self.error = "No response received. The agent may be busy — try again."
                print("[ChatVM] ⚠️ Loading timeout fired after \(self.loadingTimeoutSeconds)s — no streaming events received for agent \(self.agentId)")
            }
        }
    }

    /// Cancel the loading timeout timer.
    private func cancelLoadingTimeout() {
        loadingTimeoutTask?.cancel()
        loadingTimeoutTask = nil
    }

    // MARK: - Handle WebSocket Frames

    private func handleFrame(_ frame: AgentManagerFrame) async {
        switch frame {
        case .messageStart(let messageId):
            // Activity received — reset timeout
            startLoadingTimeout()
            // If there's already a streaming message, finalize it first
            if !streamingParts.isEmpty {
                finalizeStreamingMessage()
            }
            self.assistantMessageId = messageId
            print("[ChatVM] WS: message.start messageId=\(messageId)")

        case .delta(let partId, let field, let delta):
            // Activity received — reset timeout
            startLoadingTimeout()
            guard let assistantId = self.assistantMessageId else { break }
            if var part = self.streamingParts[partId] {
                if field == "text" {
                    part.text = (part.text ?? "") + delta
                }
                self.streamingParts[partId] = part
            } else {
                let newPart = MessagePart(
                    id: partId,
                    messageID: assistantId,
                    type: .text,
                    text: field == "text" ? delta : nil
                )
                self.streamingParts[partId] = newPart
                self.streamingPartOrder.append(partId)
            }

        case .partUpdated(let partId, let partWrapper):
            // Activity received — reset timeout
            startLoadingTimeout()
            guard let assistantId = self.assistantMessageId else { break }
            let partDict = partWrapper.value
            let typeStr = partDict["type"] as? String ?? "text"
            let partType = MessagePartType(rawValue: typeStr) ?? .text
            var part = self.streamingParts[partId] ?? MessagePart(
                id: partId,
                messageID: assistantId,
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
                        // Store structured data for interactive tools (e.g. question)
                        if let inputDict = input as? [String: Any] {
                            part.toolInputData = inputDict
                        }
                    }
                }
            }

            self.streamingParts[partId] = part
            if !self.streamingPartOrder.contains(partId) {
                self.streamingPartOrder.append(partId)
            }

        case .messageComplete(_, _, _):
            cancelLoadingTimeout()
            self.finalizeStreamingMessage()

        case .error(let message):
            print("[ChatVM] WS error frame: \(message)")
            cancelLoadingTimeout()
            if !streamingParts.isEmpty {
                finalizeStreamingMessage()
            }
            self.error = message
            self.isLoading = false

        case .idle:
            print("[ChatVM] WS: idle received")
            cancelLoadingTimeout()
            if !streamingParts.isEmpty {
                finalizeStreamingMessage()
            }
            self.isLoading = false
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

    // MARK: - Load Conversation from Agent Manager

    func loadConversation(serverManager: ServerManager) async {
        guard let baseURL = serverManager.agentManagerURL(for: workspacePath) else {
            print("[ChatVM] No agent-manager URL for loading conversation")
            return
        }

        do {
            let client = AgentManagerClient(baseURL: baseURL)
            let conversation = try await client.getConversation(agentId: agentId)

            messages = conversation.messages.compactMap { msg -> ConversationMessage? in
                let role: MessageRole = msg.role == "user" ? .user : .assistant
                let textContent = msg.contentBlocks
                    .filter { $0.type == "text" }
                    .compactMap { $0.text }
                    .joined(separator: "\n")

                let messageParts = msg.contentBlocks.enumerated().compactMap { (index, block) -> MessagePart? in
                    guard let partType = MessagePartType(rawValue: block.type) else { return nil }
                    var part = MessagePart(
                        id: "\(msg.id)-\(index)",
                        messageID: msg.id,
                        type: partType,
                        text: block.text
                    )

                    // Restore tool-specific metadata if present
                    if partType == .tool {
                        part.toolName = block.name
                        part.toolCallID = block.tool_use_id
                        if let statusStr = block.status {
                            part.toolStatus = ToolStatus(rawValue: statusStr)
                        } else {
                            part.toolStatus = .completed
                        }
                        part.toolTitle = block.title
                        part.toolOutput = block.content
                        if let input = block.input {
                            part.toolInput = stringifyJSON(input.value)
                            // Restore structured data for interactive tools
                            if let inputDict = input.value as? [String: Any] {
                                part.toolInputData = inputDict
                            }
                        }
                    }

                    return part
                }

                let hasToolParts = messageParts.contains { $0.type == .tool }
                guard !textContent.isEmpty || hasToolParts else { return nil }

                return ConversationMessage(
                    role: role,
                    content: textContent,
                    parts: messageParts,
                    timestamp: msg.timestamp ?? ISO8601DateFormatter().string(from: Date()),
                    tokens: nil,
                    cost: nil
                )
            }
        } catch {
            print("[ChatVM] Failed to load conversation from agent-manager: \(error)")
            messages = []
        }
    }

    // MARK: - Send Message (via WebSocket)

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

        // Start loading timeout
        startLoadingTimeout()

        // Ensure WebSocket is connected
        if agentManagerClient == nil {
            await connectWebSocket(serverManager: serverManager)
        }

        // Send message via WebSocket
        agentManagerClient?.sendMessage(text)
    }

    // MARK: - Submit Question Answer

    /// Submit an answer to an interactive question tool.
    /// This sends the answer as a regular user message through the WebSocket.
    func submitQuestionAnswer(_ answer: String, serverManager: ServerManager) async {
        guard !answer.isEmpty else { return }
        print("[ChatVM] Submitting question answer: \(answer.prefix(50))...")

        let userMessage = ConversationMessage(
            role: .user,
            content: answer,
            parts: [],
            timestamp: ISO8601DateFormatter().string(from: Date()),
            tokens: nil,
            cost: nil
        )
        messages.append(userMessage)
        isLoading = true
        // Do NOT clear streamingParts, streamingPartOrder, or assistantMessageId here.
        // The existing streaming message (with the question tool) should remain visible
        // while the answer is being processed. The natural streaming flow (handleFrame →
        // finalizeStreamingMessage) will handle the transition when the server responds.
        error = nil

        // Start loading timeout
        startLoadingTimeout()

        if agentManagerClient == nil {
            await connectWebSocket(serverManager: serverManager)
        }

        agentManagerClient?.sendMessage(answer)
    }

    // MARK: - Cancel Streaming

    func cancelStreaming() {
        cancelLoadingTimeout()
        agentManagerClient?.sendCancel()

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
}

/// Convert any JSON-compatible value to a string representation.
private func stringifyJSON(_ value: Any) -> String? {
    if let str = value as? String { return str }
    guard JSONSerialization.isValidJSONObject(value) else { return "\(value)" }
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
          let str = String(data: data, encoding: .utf8) else { return nil }
    return str
}

