import Foundation

struct AgentMetadata: Codable, Identifiable, Sendable {
    var id: String { agentId }

    let agentId: String
    let sessionId: String
    var label: String
    var model: String?
    var agent: String?
    var specialistId: String?
    var systemPrompt: String?
    var createdAt: String
}

