import Foundation

struct TaskDependency: Codable, Sendable {
    let prerequisiteNoteId: String
    let status: String
}

struct TaskMetadata: Codable, Sendable {
    let status: String
    var acceptanceCriteria: [String]?
    var assignedAgents: [String]?
    var dependencies: [TaskDependency]?
}

struct Note: Codable, Identifiable, Sendable {
    let id: String
    var title: String
    var content: String
    var tags: [String]
    var createdAt: String
    var updatedAt: String
    var taskMetadata: TaskMetadata?
}

