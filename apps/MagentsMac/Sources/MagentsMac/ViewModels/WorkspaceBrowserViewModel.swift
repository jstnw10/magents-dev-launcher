import Foundation
import Observation

enum WorkspaceSortOrder: String, CaseIterable, Sendable {
    case recentlyUpdated = "Recently Updated"
    case title = "Title"
    case created = "Created"
    case status = "Status"
}

@MainActor
@Observable
final class WorkspaceBrowserViewModel {
    var searchText: String = ""
    var sortOrder: WorkspaceSortOrder = .recentlyUpdated
    var showCreateSheet = false

    func filteredWorkspaces(from workspaces: [WorkspaceConfig]) -> [WorkspaceConfig] {
        var result = workspaces

        // Apply search filter
        if !searchText.isEmpty {
            let query = searchText.lowercased()
            result = result.filter { workspace in
                workspace.title.lowercased().contains(query)
                    || workspace.branch.lowercased().contains(query)
                    || (workspace.repositoryName?.lowercased().contains(query) ?? false)
            }
        }

        // Apply sort
        result.sort { a, b in
            switch sortOrder {
            case .recentlyUpdated:
                return a.updatedAt > b.updatedAt
            case .title:
                return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
            case .created:
                return a.createdAt > b.createdAt
            case .status:
                return a.status.rawValue < b.status.rawValue
            }
        }

        return result
    }

    func filteredActive(from workspaces: [WorkspaceConfig]) -> [WorkspaceConfig] {
        filteredWorkspaces(from: workspaces).filter { $0.status == .active }
    }

    func filteredArchived(from workspaces: [WorkspaceConfig]) -> [WorkspaceConfig] {
        filteredWorkspaces(from: workspaces).filter { $0.status == .archived }
    }
}

