import Foundation

/// Response types for OpenCode API
struct CreateSessionResponse: Codable, Sendable {
    let id: String
    let slug: String?
    let title: String?
}

struct PromptResponseInfo: Codable, Sendable {
    let id: String
    let role: String
    let tokens: PromptTokens?
    let cost: Double?
}

struct PromptTokens: Codable, Sendable {
    let input: Int
    let output: Int
}

struct ToolState: Codable, Sendable {
    let status: String?
    let input: AnyCodable?
    let output: String?
    let title: String?
    let error: String?
}

struct PromptPart: Codable, Sendable {
    let id: String?
    let sessionID: String?
    let messageID: String?
    let type: String
    let text: String?
    // Tool-specific fields
    let callID: String?
    let tool: String?
    let state: ToolState?
}

struct PromptResponse: Codable, Sendable {
    let info: PromptResponseInfo?
    let parts: [PromptPart]?
}

struct MessageInfo: Codable, Sendable {
    let id: String
    let role: String
    let time: MessageTime?
}

struct MessageTime: Codable, Sendable {
    let created: Double?
}

struct MessageResponse: Codable, Sendable {
    let info: MessageInfo
    let parts: [PromptPart]
}

/// HTTP client for communicating with the OpenCode server.
struct OpenCodeClient: Sendable {
    let baseURL: URL

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    init(serverInfo: ServerInfo) {
        self.baseURL = URL(string: serverInfo.url)!
    }

    // MARK: - Session Management

    func createSession(directory: String, title: String) async throws -> CreateSessionResponse {
        let url = baseURL.appendingPathComponent("session")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: String] = ["directory": directory, "title": title]
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response, data: data)

        do {
            return try JSONDecoder().decode(CreateSessionResponse.self, from: data)
        } catch {
            let bodyStr = String(data: data, encoding: .utf8) ?? "<non-utf8>"
            print("[OpenCodeClient] Failed to decode CreateSessionResponse: \(error)")
            print("[OpenCodeClient] Response body: \(bodyStr)")
            throw error
        }
    }

    func deleteSession(id: String) async throws {
        let url = baseURL.appendingPathComponent("session/\(id)")
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response, data: data)
    }

    // MARK: - Messaging

    func sendPrompt(sessionId: String, text: String) async throws -> PromptResponse {
        let url = baseURL.appendingPathComponent("session/\(sessionId)/message")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 600 // 10 minutes — LLM responses can take a while

        let body: [String: Any] = [
            "parts": [["type": "text", "text": text]],
            "model": ["providerID": "opencode", "modelID": "claude-opus-4-6"]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response, data: data)

        do {
            return try JSONDecoder().decode(PromptResponse.self, from: data)
        } catch {
            let bodyStr = String(data: data, encoding: .utf8) ?? "<non-utf8>"
            print("[OpenCodeClient] Failed to decode PromptResponse: \(error)")
            print("[OpenCodeClient] Response body: \(bodyStr)")
            throw error
        }
    }

    /// Send a prompt without waiting for the full LLM response.
    /// The request is fired in a detached task; use SSE events to track the response in real-time.
    func sendPromptFireAndForget(sessionId: String, text: String) async throws {
        let url = baseURL.appendingPathComponent("session/\(sessionId)/message")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 600 // 10 minutes

        let body: [String: Any] = [
            "parts": [["type": "text", "text": text]],
            "model": ["providerID": "opencode", "modelID": "claude-opus-4-6"]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        // Fire and forget — start the request in background.
        // We don't await the response; SSE events will deliver the streaming content.
        Task.detached {
            do {
                let (_, _) = try await URLSession.shared.data(for: request)
            } catch {
                print("[OpenCodeClient] Background prompt request completed/error: \(error.localizedDescription)")
            }
        }
    }

    func getMessages(sessionId: String) async throws -> [MessageResponse] {
        let url = baseURL.appendingPathComponent("session/\(sessionId)/message")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response, data: data)

        do {
            return try JSONDecoder().decode([MessageResponse].self, from: data)
        } catch {
            let bodyStr = String(data: data, encoding: .utf8) ?? "<non-utf8>"
            print("[OpenCodeClient] Failed to decode [MessageResponse]: \(error)")
            print("[OpenCodeClient] Response body: \(bodyStr)")
            throw error
        }
    }

    // MARK: - Helpers

    private func validateResponse(_ response: URLResponse, data: Data? = nil) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw OpenCodeClientError.invalidResponse
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            print("[OpenCodeClient] HTTP \(httpResponse.statusCode): \(body)")
            throw OpenCodeClientError.httpError(statusCode: httpResponse.statusCode)
        }
    }
}

enum OpenCodeClientError: Error, LocalizedError {
    case invalidResponse
    case httpError(statusCode: Int)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid response from OpenCode server"
        case .httpError(let statusCode):
            return "HTTP error \(statusCode) from OpenCode server"
        }
    }
}

