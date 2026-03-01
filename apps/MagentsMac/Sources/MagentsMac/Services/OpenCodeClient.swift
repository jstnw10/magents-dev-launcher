import Foundation

/// Response types for OpenCode API
struct CreateSessionResponse: Codable, Sendable {
    let id: String
    let slug: String?
    let title: String?
}

/// HTTP client for communicating with the OpenCode server.
/// Used only for session management (create/delete). Messages go through agent-manager.
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

