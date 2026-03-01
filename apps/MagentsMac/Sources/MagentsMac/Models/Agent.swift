import Foundation

enum AgentStatus: String, Codable, Sendable {
    case idle
    case busy
    case retry
}

struct AgentMetadata: Codable, Identifiable, Sendable {
    var id: String { agentId }

    let agentId: String
    let sessionId: String
    var label: String
    var model: String?
    var agent: String?
    var specialistId: String?
    var systemPrompt: String?
    var hasReceivedFirstMessage: Bool?
    var createdAt: String
    var status: AgentStatus?
}

