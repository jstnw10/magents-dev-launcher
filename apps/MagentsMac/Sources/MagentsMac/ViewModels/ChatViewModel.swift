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

    init(agentId: String, sessionId: String, workspacePath: String) {
        self.agentId = agentId
        self.sessionId = sessionId
        self.workspacePath = workspacePath
    }

    // MARK: - Load Conversation from Disk

    func loadConversation() async {
        let path = "\(workspacePath)/.workspace/opencode/conversations/\(agentId).json"
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            let conversation = try JSONDecoder().decode(Conversation.self, from: data)
            messages = conversation.messages
        } catch {
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

            // 3. Listen for SSE events and accumulate streaming text
            var receivedResponse = false
            for await event in eventStream {
                guard let jsonData = event.data.data(using: .utf8) else { continue }

                guard let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
                    continue
                }

                // Filter events for our session
                let eventSessionId = json["sessionID"] as? String ?? json["session_id"] as? String
                if let sid = eventSessionId, sid != sessionId { continue }

                let eventType = event.event ?? json["type"] as? String ?? ""

                if eventType.contains("text") && eventType.contains("delta") {
                    if let deltaText = json["text"] as? String {
                        streamingText += deltaText
                    } else if let props = json["properties"] as? [String: Any],
                              let deltaText = props["text"] as? String {
                        streamingText += deltaText
                    }
                } else if (eventType.contains("text") && eventType.contains("end"))
                    || (eventType.contains("message") && eventType.contains("complete"))
                    || eventType.contains("finish") || eventType.contains("done") {
                    receivedResponse = true
                } else {
                    print("[ChatVM] SSE event: \(eventType) — \(event.data.prefix(200))")
                }

                if receivedResponse { break }
            }

            // 4. Finalize — create assistant message from streamed text
            let finalText = streamingText.isEmpty ? "(No response received)" : streamingText
            let assistantMessage = ConversationMessage(
                role: .assistant,
                content: finalText,
                parts: [],
                timestamp: ISO8601DateFormatter().string(from: Date()),
                tokens: nil,
                cost: nil
            )
            messages.append(assistantMessage)
            streamingText = ""
            sseClient.disconnect()
            self.sseClient = nil

        } catch {
            // Fallback: if SSE fails, try the synchronous prompt
            await sendMessageFallback(serverManager: serverManager, text: text)
            return
        }

        isLoading = false
    }

    // MARK: - Fallback (synchronous prompt)

    private func sendMessageFallback(serverManager: ServerManager, text: String) async {
        // Clean up SSE state
        sseClient?.disconnect()
        sseClient = nil
        streamingText = ""

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

