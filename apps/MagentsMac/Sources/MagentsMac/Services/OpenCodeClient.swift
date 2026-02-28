import Foundation

/// Response types for OpenCode API
struct CreateSessionResponse: Codable, Sendable {
    let id: String
    let slug: String
    let title: String
}

struct PromptResponse: Codable, Sendable {
    let content: String
}

struct MessageResponse: Codable, Sendable {
    let role: String
    let content: String
    let timestamp: String?
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
        let url = baseURL.appendingPathComponent("/session/create")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: String] = ["directory": directory, "title": title]
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        return try JSONDecoder().decode(CreateSessionResponse.self, from: data)
    }

    func deleteSession(id: String) async throws {
        let url = baseURL.appendingPathComponent("/session/\(id)")
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"

        let (_, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
    }

    // MARK: - Messaging

    func sendPrompt(sessionId: String, text: String) async throws -> PromptResponse {
        let url = baseURL.appendingPathComponent("/session/\(sessionId)/prompt")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: String] = ["text": text]
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        return try JSONDecoder().decode(PromptResponse.self, from: data)
    }

    func getMessages(sessionId: String) async throws -> [MessageResponse] {
        let url = baseURL.appendingPathComponent("/session/\(sessionId)/messages")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)
        return try JSONDecoder().decode([MessageResponse].self, from: data)
    }

    // MARK: - Helpers

    private func validateResponse(_ response: URLResponse) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw OpenCodeClientError.invalidResponse
        }
        guard (200...299).contains(httpResponse.statusCode) else {
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

