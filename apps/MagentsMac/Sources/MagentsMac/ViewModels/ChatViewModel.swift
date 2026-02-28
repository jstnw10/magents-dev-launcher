import Foundation
import Observation

@MainActor
@Observable
final class ChatViewModel {
    var messages: [ConversationMessage] = []
    var inputText: String = ""
    var isLoading: Bool = false
    var error: String?

    let agentId: String
    let sessionId: String
    let workspacePath: String

    private let fileManager = WorkspaceFileManager()

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
            // No conversation file yet — start fresh
            messages = []
        }
    }

    // MARK: - Send Message

    func sendMessage() async {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        // Create and append user message
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
        error = nil

        do {
            let client = try await makeClient()
            let response = try await client.sendPrompt(sessionId: sessionId, text: text)

            // Extract text content from response parts
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

    // MARK: - Helpers

    private func makeClient() async throws -> OpenCodeClient {
        guard let serverInfo = try await fileManager.readServerInfo(workspacePath: workspacePath) else {
            throw ChatViewModelError.serverNotRunning
        }
        return OpenCodeClient(serverInfo: serverInfo)
    }
}

enum ChatViewModelError: Error, LocalizedError {
    case serverNotRunning

    var errorDescription: String? {
        switch self {
        case .serverNotRunning:
            return "OpenCode server is not running for this workspace."
        }
    }
}

