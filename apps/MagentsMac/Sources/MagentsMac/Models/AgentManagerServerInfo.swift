import Foundation

/// Server info for the agent-manager WebSocket/HTTP server.
/// Read from `.workspace/agent-manager/server.json`.
struct AgentManagerServerInfo: Codable, Sendable {
    let port: Int
    let url: String
    let startedAt: String
}

