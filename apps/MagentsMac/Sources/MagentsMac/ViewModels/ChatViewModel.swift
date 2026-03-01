import Foundation
import Observation

@MainActor
@Observable
final class ChatViewModel {
    var messages: [ConversationMessage] = []
    var inputText: String = ""
    var isLoading: Bool = false
    var streamingText: String = ""
    var error: String?

    let agentId: String
    let sessionId: String
    let workspacePath: String

    private let fileManager = WorkspaceFileManager()
    private var sseClient: SSEClient?
    private var streamingTask: Task<Void, Never>?
    private var assistantMessageId: String?

    init(agentId: String, sessionId: String, workspacePath: String) {
        self.agentId = agentId
        self.sessionId = sessionId
        self.workspacePath = workspacePath
    }

    // MARK: - Load Conversation from Server

    func loadConversation(serverManager: ServerManager) async {
        do {
            let serverInfo = try await serverManager.getOrStart(workspacePath: workspacePath)
            let client = OpenCodeClient(serverInfo: serverInfo)
            let serverMessages = try await client.getMessages(sessionId: sessionId)

            // Convert server messages to ConversationMessage
            messages = serverMessages.compactMap { msg -> ConversationMessage? in
                let role: MessageRole = msg.info.role == "user" ? .user : .assistant
                let textParts = msg.parts.compactMap { $0.text }
                let content = textParts.joined(separator: "\n")

                // Skip empty messages
                guard !content.isEmpty else { return nil }

                return ConversationMessage(
                    role: role,
                    content: content,
                    parts: [],
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

    // MARK: - Send Message with SSE Streaming

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
        streamingText = ""
        assistantMessageId = nil
        error = nil

        do {
            let serverInfo = try await serverManager.getOrStart(workspacePath: workspacePath)
            let client = OpenCodeClient(serverInfo: serverInfo)

            // 1. Connect to SSE stream FIRST so we don't miss events
            let sseClient = SSEClient(baseURL: URL(string: serverInfo.url)!)
            self.sseClient = sseClient
            let eventStream = sseClient.connect()

            // 2. Send prompt (fire and forget — response comes via SSE)
            try await client.sendPromptFireAndForget(sessionId: sessionId, text: text)

            // 3. Listen for SSE events in a STORED task — not subject to SwiftUI Task cancellation.
            //    The SwiftUI `Task { await viewModel.sendMessage(...) }` can be cancelled when the
            //    view re-renders (e.g. when isLoading or streamingText changes). By running the SSE
            //    loop in a separate stored Task, we prevent premature cancellation.
            let sid = sessionId
            streamingTask = Task { [weak self] in
                var receivedResponse = false
                for await event in eventStream {
                    guard let self = self else { break }
                    guard !Task.isCancelled else { break }

                    guard let jsonData = event.data.data(using: .utf8) else { continue }
                    guard let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else { continue }

                    let eventType = json["type"] as? String ?? ""
                    let properties = json["properties"] as? [String: Any] ?? [:]

                    // Filter events for our session
                    let eventSessionId = properties["sessionID"] as? String
                        ?? (properties["info"] as? [String: Any])?["sessionID"] as? String
                        ?? (properties["part"] as? [String: Any])?["sessionID"] as? String
                    if let eventSid = eventSessionId, eventSid != sid { continue }

                    // Extract message ID from event properties
                    let msgId = properties["messageID"] as? String
                        ?? (properties["info"] as? [String: Any])?["id"] as? String
                        ?? (properties["part"] as? [String: Any])?["messageID"] as? String

                    // Extract role from event properties
                    let role = (properties["info"] as? [String: Any])?["role"] as? String

                    print("[ChatVM] SSE: type=\(eventType) role=\(role ?? "nil") msgId=\(msgId ?? "nil")")

                    await MainActor.run {
                        switch eventType {
                        case "message.updated":
                            if let info = properties["info"] as? [String: Any],
                               let messageRole = info["role"] as? String,
                               let messageId = info["id"] as? String {
                                if messageRole == "assistant" {
                                    // Track the assistant message ID so we only accumulate its deltas
                                    self.assistantMessageId = messageId
                                    print("[ChatVM] SSE: tracking assistant messageId=\(messageId)")
                                }
                                // Check if assistant message is completed
                                if messageRole == "assistant",
                                   let time = info["time"] as? [String: Any],
                                   time["completed"] != nil {
                                    receivedResponse = true
                                }
                            }

                        case "message.part.delta":
                            // Only accumulate deltas once we've identified the assistant message
                            guard let assistantId = self.assistantMessageId else {
                                print("[ChatVM] SSE: skipping delta, no assistant message identified yet")
                                break
                            }
                            // If this delta has a messageID, verify it matches the assistant
                            if let deltaMsgId = properties["messageID"] as? String,
                               deltaMsgId != assistantId {
                                print("[ChatVM] SSE: skipping delta for non-assistant msgId=\(deltaMsgId)")
                                break
                            }
                            if let delta = properties["delta"] as? String {
                                self.streamingText += delta
                            }

                        case "message.part.updated":
                            // Only accumulate once we've identified the assistant message
                            guard let assistantId = self.assistantMessageId else {
                                print("[ChatVM] SSE: skipping part.updated, no assistant message identified yet")
                                break
                            }
                            // If this part has a messageID, verify it matches the assistant
                            if let partMsgId = (properties["part"] as? [String: Any])?["messageID"] as? String,
                               partMsgId != assistantId {
                                print("[ChatVM] SSE: skipping part.updated for non-assistant msgId=\(partMsgId)")
                                break
                            }
                            if let part = properties["part"] as? [String: Any],
                               part["type"] as? String == "text",
                               let text = part["text"] as? String,
                               !text.isEmpty {
                                if text.count > self.streamingText.count {
                                    self.streamingText = text
                                }
                            }

                        case "session.idle":
                            receivedResponse = true

                        case "server.heartbeat", "server.connected", "file.watcher.updated",
                             "session.updated", "session.diff", "session.status",
                             "todo.updated":
                            break

                        default:
                            print("[ChatVM] SSE event: \(eventType)")
                        }
                    }

                    if receivedResponse { break }
                }

                // Finalize on main actor
                await MainActor.run { [weak self] in
                    guard let self = self else { return }
                    let finalText = self.streamingText.isEmpty ? "(No response received)" : self.streamingText
                    let assistantMessage = ConversationMessage(
                        role: .assistant,
                        content: finalText,
                        parts: [],
                        timestamp: ISO8601DateFormatter().string(from: Date()),
                        tokens: nil,
                        cost: nil
                    )
                    self.messages.append(assistantMessage)
                    self.streamingText = ""
                    self.assistantMessageId = nil
                    self.sseClient?.disconnect()
                    self.sseClient = nil
                    self.isLoading = false
                }
            }

            // NOTE: sendMessage returns here immediately after launching the streaming task.
            // isLoading = false is set inside the streamingTask when it completes.

        } catch {
            // Fallback: if SSE setup fails, try the synchronous prompt
            await sendMessageFallback(serverManager: serverManager, text: text)
        }
    }

    // MARK: - Fallback (synchronous prompt)

    private func sendMessageFallback(serverManager: ServerManager, text: String) async {
        // Clean up SSE state
        sseClient?.disconnect()
        sseClient = nil
        streamingText = ""
        assistantMessageId = nil

        do {
            let serverInfo = try await serverManager.getOrStart(workspacePath: workspacePath)
            let client = OpenCodeClient(serverInfo: serverInfo)
            let response = try await client.sendPrompt(sessionId: sessionId, text: text)

            let responseText = response.parts?
                .compactMap { $0.text }
                .joined(separator: "\n") ?? ""

            let assistantMessage = ConversationMessage(
                role: .assistant,
                content: responseText,
                parts: [],
                timestamp: ISO8601DateFormatter().string(from: Date()),
                tokens: response.info.flatMap { info in
                    info.tokens.map { MessageTokens(input: $0.input, output: $0.output) }
                },
                cost: response.info?.cost
            )
            messages.append(assistantMessage)
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    // MARK: - Cancel Streaming

    func cancelStreaming() {
        streamingTask?.cancel()
        streamingTask = nil
        sseClient?.disconnect()
        sseClient = nil
        if !streamingText.isEmpty {
            let assistantMessage = ConversationMessage(
                role: .assistant,
                content: streamingText,
                parts: [],
                timestamp: ISO8601DateFormatter().string(from: Date()),
                tokens: nil,
                cost: nil
            )
            messages.append(assistantMessage)
            streamingText = ""
        }
        isLoading = false
    }
}

