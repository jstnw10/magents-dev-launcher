import SwiftUI

struct ContentView: View {
    @Environment(WorkspaceViewModel.self) private var viewModel
    @Environment(TabManager.self) private var tabManager

    var body: some View {
        NavigationSplitView {
            SidebarView()
        } detail: {
            VStack(spacing: 0) {
                // Tab bar (only show if tabs exist)
                if !tabManager.tabs.isEmpty {
                    if #available(macOS 26.0, *) {
                        TabBarView(tabManager: tabManager)
                    }
                }

                // Workspace header (show when active tab has a workspace)
                if let tab = tabManager.activeTab,
                   let workspaceId = tab.workspaceId,
                   let workspace = viewModel.workspaces.first(where: { $0.id == workspaceId }) {
                    WorkspaceHeaderView(workspace: workspace)
                }

                // Content based on active tab
                if let tab = tabManager.activeTab {
                    tabContent(for: tab)
                } else {
                    welcomeView
                }
            }
        }
        .navigationSplitViewColumnWidth(min: 220, ideal: 250, max: 280)
        .navigationTitle(windowTitle)
    }

    // MARK: - Window Title

    private var windowTitle: String {
        if let tab = tabManager.activeTab {
            return tab.title
        }
        return "Magents"
    }

    // MARK: - Tab Content

    @ViewBuilder
    private func tabContent(for tab: TabItem) -> some View {
        switch tab.contentType {
        case .chat(let agentId):
            if let workspacePath = workspacePath(for: tab),
               let agent = findAgent(agentId: agentId, workspaceId: tab.workspaceId) {
                ChatView(
                    agentId: agentId,
                    sessionId: agent.sessionId,
                    workspacePath: workspacePath
                )
            } else {
                contentUnavailableView(
                    icon: "bubble.left.and.exclamationmark.bubble.right",
                    title: "Agent Not Found",
                    message: "The agent for this chat could not be located."
                )
            }

        case .note(let noteId):
            if let workspacePath = workspacePath(for: tab) {
                DocumentView(
                    noteId: noteId,
                    workspacePath: workspacePath
                )
            } else {
                contentUnavailableView(
                    icon: "doc.questionmark",
                    title: "Workspace Not Found",
                    message: "The workspace for this note could not be located."
                )
            }

        case .spec(let workspaceId):
            if let workspace = viewModel.workspaces.first(where: { $0.id == workspaceId }) {
                DocumentView(
                    noteId: "spec",
                    workspacePath: workspace.path,
                    isSpec: true
                )
            } else {
                contentUnavailableView(
                    icon: "doc.questionmark",
                    title: "Workspace Not Found",
                    message: "The workspace for this spec could not be located."
                )
            }

        case .workspaceBrowser:
            WorkspaceBrowserView()
        }
    }

    // MARK: - Helpers

    private func workspacePath(for tab: TabItem) -> String? {
        guard let workspaceId = tab.workspaceId,
              let workspace = viewModel.workspaces.first(where: { $0.id == workspaceId })
        else { return nil }
        return workspace.path
    }

    private func findAgent(agentId: String, workspaceId: String?) -> AgentMetadata? {
        guard let workspaceId else { return nil }
        return viewModel.agentsForWorkspace[workspaceId]?.first { $0.agentId == agentId }
    }

    private func contentUnavailableView(icon: String, title: String, message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text(title)
                .font(.title2)
            Text(message)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Welcome View

    private var welcomeView: some View {
        VStack(spacing: 12) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("Welcome to Magents")
                .font(.title)
            Text("Select a workspace or agent to get started.")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

