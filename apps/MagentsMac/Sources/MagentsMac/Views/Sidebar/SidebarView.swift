import SwiftUI

struct SidebarView: View {
    @Environment(WorkspaceViewModel.self) private var viewModel
    @Environment(TabManager.self) private var tabManager
    @State private var showCreateSheet = false
    @State private var showDestroyConfirmation = false
    @State private var workspaceToDestroy: WorkspaceConfig?
    @State private var showCreateAgentSheet = false
    @State private var createAgentWorkspace: WorkspaceConfig?

    var body: some View {
        @Bindable var vm = viewModel

        List(selection: $vm.selectedWorkspaceId) {
            if !viewModel.activeWorkspaces.isEmpty {
                Section("Active") {
                    ForEach(viewModel.activeWorkspaces) { workspace in
                        workspaceDisclosure(workspace)
                    }
                }
            }

            if !viewModel.archivedWorkspaces.isEmpty {
                Section("Archived") {
                    ForEach(viewModel.archivedWorkspaces) { workspace in
                        workspaceDisclosure(workspace)
                    }
                }
            }
        }
        .navigationTitle("Magents")
        .task {
            await viewModel.loadWorkspaces()
        }
        .overlay {
            if viewModel.isLoading && viewModel.workspaces.isEmpty {
                ProgressView("Loading…")
            } else if !viewModel.isLoading && viewModel.workspaces.isEmpty {
                ContentUnavailableView(
                    "No Workspaces",
                    systemImage: "folder.badge.questionmark",
                    description: Text("Create a workspace to get started.")
                )
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 4) {
                if let selected = viewModel.selectedWorkspace {
                    ServerStatusView(workspacePath: selected.path)
                }

                Button {
                    showCreateSheet = true
                } label: {
                    Label("New Workspace", systemImage: "plus")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
        }
        .sheet(isPresented: $showCreateSheet) {
            CreateWorkspaceSheet()
                .environment(viewModel)
                .environment(tabManager)
        }
        .sheet(isPresented: $showCreateAgentSheet) {
            if let ws = createAgentWorkspace {
                CreateAgentSheet(workspacePath: ws.path, workspaceId: ws.id)
                    .environment(viewModel)
                    .environment(tabManager)
            }
        }
        .alert("Destroy Workspace?", isPresented: $showDestroyConfirmation) {
            Button("Cancel", role: .cancel) { }
            Button("Destroy", role: .destructive) {
                if let ws = workspaceToDestroy {
                    Task {
                        let wfm = WorkspaceFileManager()
                        try? await wfm.destroyWorkspace(ws)
                        await viewModel.loadWorkspaces()
                    }
                }
            }
        } message: {
            if let ws = workspaceToDestroy {
                Text("This will permanently delete \"\(ws.title)\" and all its data. This cannot be undone.")
            }
        }
    }

    // MARK: - Workspace Disclosure

    @ViewBuilder
    private func workspaceDisclosure(_ workspace: WorkspaceConfig) -> some View {
        DisclosureGroup {
            let agents = viewModel.agents(for: workspace)
            if agents.isEmpty {
                Text("No agents")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(agents) { agent in
                    AgentRow(agent: agent, workspacePath: workspace.path) {
                        // On remove: refresh agents list
                        viewModel.agentsForWorkspace[workspace.id] = nil
                        Task { await viewModel.loadAgents(for: workspace) }
                    }
                    .tag(agent.agentId)
                    .onTapGesture {
                        viewModel.selectedAgentId = agent.agentId
                        tabManager.openTab(TabItem(
                            title: agent.label,
                            icon: "bubble.left.fill",
                            contentType: .chat(agentId: agent.agentId),
                            workspaceId: workspace.id
                        ))
                    }
                }
            }

            Button {
                createAgentWorkspace = workspace
                showCreateAgentSheet = true
            } label: {
                Label("New Agent", systemImage: "plus.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        } label: {
            WorkspaceRow(workspace: workspace)
                .tag(workspace.id)
                .onTapGesture {
                    viewModel.selectedWorkspaceId = workspace.id
                }
                .simultaneousGesture(
                    TapGesture(count: 2).onEnded {
                        tabManager.openTab(TabItem(
                            title: "Spec",
                            icon: "doc.text",
                            contentType: .spec(workspaceId: workspace.id),
                            workspaceId: workspace.id
                        ))
                    }
                )
                .contextMenu {
                    workspaceContextMenu(workspace)
                }
        }
        .task {
            await viewModel.loadAgents(for: workspace)
        }
    }

    // MARK: - Context Menu

    @ViewBuilder
    private func workspaceContextMenu(_ workspace: WorkspaceConfig) -> some View {
        Button(workspace.status == .active ? "Archive" : "Unarchive") {
            Task {
                let wfm = WorkspaceFileManager()
                if workspace.status == .active {
                    try? await wfm.archiveWorkspace(at: workspace.path)
                } else {
                    try? await wfm.unarchiveWorkspace(at: workspace.path)
                }
                await viewModel.loadWorkspaces()
            }
        }
        Divider()
        Button("Open in Terminal") {
            let path = workspace.path
            Task {
                _ = try? await ShellRunner.run("open -a Terminal \(path)")
            }
        }
        Button("Open in Finder") {
            NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: workspace.path)
        }
        Button("Copy Path") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(workspace.path, forType: .string)
        }
        Divider()
        Button("Destroy", role: .destructive) {
            workspaceToDestroy = workspace
            showDestroyConfirmation = true
        }
    }
}

