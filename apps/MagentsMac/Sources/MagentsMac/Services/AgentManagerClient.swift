import Foundation
import os

/// WebSocket + HTTP client for the agent-manager server.
/// Replaces direct OpenCode HTTP/SSE communication for chat messages.
final class AgentManagerClient: NSObject, @unchecked Sendable {
    let baseURL: URL
    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession?
    private let continuationLock = OSAllocatedUnfairLock<AsyncStream<AgentManagerFrame>.Continuation?>(initialState: nil)

    init(baseURL: URL) {
        self.baseURL = baseURL
        super.init()
    }

    init(serverInfo: AgentManagerServerInfo) {
        self.baseURL = URL(string: serverInfo.url)!
        super.init()
    }

    // MARK: - WebSocket Connection

    /// Connect to the agent-manager WebSocket for a specific agent.
    /// Returns an AsyncStream of frames from the server.
    func connect(agentId: String) -> AsyncStream<AgentManagerFrame> {
        disconnect()

        let wsURL = baseURL
            .deletingLastPathComponent() // remove trailing slash issues
        var components = URLComponents(url: wsURL, resolvingAgainstBaseURL: false)!
        components.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        components.path = "/agent/\(agentId)"
        let url = components.url!

        let config = URLSessionConfiguration.default
        let urlSession = URLSession(configuration: config)
        self.session = urlSession

        let task = urlSession.webSocketTask(with: url)
        self.webSocketTask = task
        task.resume()

        return AsyncStream { continuation in
            self.continuationLock.withLock { $0 = continuation }
            continuation.onTermination = { @Sendable _ in
                task.cancel(with: .goingAway, reason: nil)
            }
            self.receiveLoop(task: task)
        }
    }

    /// Disconnect the WebSocket.
    func disconnect() {
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        continuationLock.withLock { cont in
            cont?.finish()
            cont = nil
        }
        session?.invalidateAndCancel()
        session = nil
    }

    // MARK: - Send Messages

    /// Send a user message through the WebSocket.
    func sendMessage(_ text: String) {
        let frame: [String: String] = ["type": "message", "text": text]
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let jsonString = String(data: data, encoding: .utf8) else { return }
        webSocketTask?.send(.string(jsonString)) { error in
            if let error {
                print("[AgentManagerClient] Send error: \(error.localizedDescription)")
            }
        }
    }

    /// Send a cancel frame through the WebSocket.
    func sendCancel() {
        let frame: [String: String] = ["type": "cancel"]
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let jsonString = String(data: data, encoding: .utf8) else { return }
        webSocketTask?.send(.string(jsonString)) { _ in }
    }

    // MARK: - HTTP Endpoints

    /// Load conversation history for an agent via HTTP.
    func getConversation(agentId: String) async throws -> AgentConversationResponse {
        let url = baseURL.appendingPathComponent("agent/\(agentId)/conversation")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw AgentManagerClientError.httpError(statusCode: statusCode)
        }

        return try JSONDecoder().decode(AgentConversationResponse.self, from: data)
    }

    // MARK: - Private

    private func receiveLoop(task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    if let frame = AgentManagerFrame.parse(text) {
                        self.continuationLock.withLock { _ = $0?.yield(frame) }
                    }
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8),
                       let frame = AgentManagerFrame.parse(text) {
                        self.continuationLock.withLock { _ = $0?.yield(frame) }
                    }
                @unknown default:
                    break
                }
                self.receiveLoop(task: task)
            case .failure(let error):
                print("[AgentManagerClient] WebSocket receive error: \(error.localizedDescription)")
                self.continuationLock.withLock { cont in
                    cont?.finish()
                    cont = nil
                }
            }
        }
    }
}



// MARK: - Frame Types

/// A sendable wrapper for JSON dictionaries.
struct SendableDict: @unchecked Sendable {
    let value: [String: Any]
}

/// A frame received from the agent-manager WebSocket.
enum AgentManagerFrame: @unchecked Sendable {
    case messageStart(messageId: String)
    case delta(partId: String, field: String, delta: String)
    case partUpdated(partId: String, part: SendableDict)
    case messageComplete(messageId: String, tokens: SendableDict?, cost: Double?)
    case error(message: String)
    case idle

    static func parse(_ text: String) -> AgentManagerFrame? {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return nil }

        switch type {
        case "message.start":
            guard let messageId = json["messageId"] as? String else { return nil }
            return .messageStart(messageId: messageId)
        case "delta":
            guard let partId = json["partId"] as? String,
                  let field = json["field"] as? String,
                  let delta = json["delta"] as? String else { return nil }
            return .delta(partId: partId, field: field, delta: delta)
        case "part.updated":
            guard let partId = json["partId"] as? String,
                  let part = json["part"] as? [String: Any] else { return nil }
            return .partUpdated(partId: partId, part: SendableDict(value: part))
        case "message.complete":
            guard let messageId = json["messageId"] as? String else { return nil }
            let tokens = (json["tokens"] as? [String: Any]).map { SendableDict(value: $0) }
            let cost = json["cost"] as? Double
            return .messageComplete(messageId: messageId, tokens: tokens, cost: cost)
        case "error":
            let message = json["message"] as? String ?? "Unknown error"
            return .error(message: message)
        case "idle":
            return .idle
        default:
            return nil
        }
    }
}

// MARK: - Conversation Response (from GET /agent/:id/conversation)

/// Matches the conversation log format from agent-manager.
struct AgentConversationResponse: Codable, Sendable {
    let id: String
    let metadata: AgentConversationMetadata?
    let messages: [AgentConversationMessage]
}

struct AgentConversationMetadata: Codable, Sendable {
    let label: String?
    let specialistId: String?
    let model: String?
}

struct AgentConversationMessage: Codable, Sendable {
    let id: String
    let role: String
    let contentBlocks: [AgentContentBlock]
    let timestamp: String?
}

struct AgentContentBlock: Codable, Sendable {
    let type: String
    let text: String?
    // Tool-specific fields
    let name: String?
    let input: AnyCodable?
    let content: String?
    let tool_use_id: String?
}

// MARK: - Errors

enum AgentManagerClientError: Error, LocalizedError {
    case httpError(statusCode: Int)

    var errorDescription: String? {
        switch self {
        case .httpError(let statusCode):
            return "HTTP error \(statusCode) from agent-manager"
        }
    }
}
