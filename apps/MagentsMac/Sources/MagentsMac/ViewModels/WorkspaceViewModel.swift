import Foundation
import Observation

@MainActor
@Observable
final class WorkspaceViewModel {
    var workspaces: [WorkspaceConfig] = []
    var selectedWorkspaceId: String?
    var selectedAgentId: String?
    var agentsForWorkspace: [String: [AgentMetadata]] = [:]
    var isLoading = false

    private let fileManager = WorkspaceFileManager()

    // MARK: - Computed Properties

    var activeWorkspaces: [WorkspaceConfig] {
        workspaces.filter { $0.status == .active }
    }

    var archivedWorkspaces: [WorkspaceConfig] {
        workspaces.filter { $0.status == .archived }
    }

    var selectedWorkspace: WorkspaceConfig? {
        guard let selectedWorkspaceId else { return nil }
        return workspaces.first { $0.id == selectedWorkspaceId }
    }

    // MARK: - Loading

    func loadWorkspaces() async {
        isLoading = true
        defer { isLoading = false }

        do {
            workspaces = try await fileManager.listWorkspaces()
        } catch {
            print("Failed to load workspaces: \(error)")
            workspaces = []
        }
    }

    func loadAgents(for workspace: WorkspaceConfig) async {
        guard agentsForWorkspace[workspace.id] == nil else { return }

        do {
            let agents = try await fileManager.listAgents(workspacePath: workspace.path)
            agentsForWorkspace[workspace.id] = agents
        } catch {
            print("Failed to load agents for \(workspace.title): \(error)")
            agentsForWorkspace[workspace.id] = []
        }
    }

    func agents(for workspace: WorkspaceConfig) -> [AgentMetadata] {
        agentsForWorkspace[workspace.id] ?? []
    }
}

