import Foundation

enum WorkspaceStatus: String, Codable, Sendable {
    case active
    case archived
}

struct WorkspaceConfig: Codable, Identifiable, Sendable {
    let id: String
    var title: String
    var branch: String
    var baseRef: String
    var baseCommitSha: String
    var status: WorkspaceStatus
    var createdAt: String
    var updatedAt: String
    var path: String
    var repositoryPath: String
    var repositoryOwner: String?
    var repositoryName: String?
    var worktreePath: String
    var tags: [String]
    var archived: Bool?
    var archivedAt: String?
}

