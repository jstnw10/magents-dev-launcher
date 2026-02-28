import SwiftUI

struct WorkspaceBrowserView: View {
    @Environment(WorkspaceViewModel.self) private var viewModel
    @Environment(TabManager.self) private var tabManager
    @State private var browserVM = WorkspaceBrowserViewModel()

    private let columns = [
        GridItem(.adaptive(minimum: 280, maximum: 400), spacing: 16)
    ]

    var body: some View {
        VStack(spacing: 0) {
            // Toolbar: search, sort, new workspace
            HStack(spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("Search workspaces…", text: $browserVM.searchText)
                        .textFieldStyle(.plain)
                }
                .padding(8)
                .background(.regularMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 8))

                Picker("Sort", selection: $browserVM.sortOrder) {
                    ForEach(WorkspaceSortOrder.allCases, id: \.self) { order in
                        Text(order.rawValue).tag(order)
                    }
                }
                .pickerStyle(.menu)
                .frame(width: 180)

                Button {
                    browserVM.showCreateSheet = true
                } label: {
                    Label("New Workspace", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)

            // Content
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    let active = browserVM.filteredActive(from: viewModel.workspaces)
                    let archived = browserVM.filteredArchived(from: viewModel.workspaces)

                    if active.isEmpty && archived.isEmpty {
                        emptyState
                    } else {
                        if !active.isEmpty {
                            workspaceSection(title: "Active", workspaces: active, expanded: true)
                        }
                        if !archived.isEmpty {
                            workspaceSection(title: "Archived", workspaces: archived, expanded: false)
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            }
        }
        .task {
            await viewModel.loadWorkspaces()
        }
        .sheet(isPresented: $browserVM.showCreateSheet) {
            CreateWorkspaceSheet()
                .environment(viewModel)
                .environment(tabManager)
        }
    }

    @ViewBuilder
    private func workspaceSection(title: String, workspaces: [WorkspaceConfig], expanded: Bool) -> some View {
        DisclosureGroup(title) {
            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(workspaces) { workspace in
                    WorkspaceCardView(
                        workspace: workspace,
                        agentCount: viewModel.agents(for: workspace).count
                    )
                    .onTapGesture {
                        selectWorkspace(workspace)
                    }
                }
            }
            .padding(.top, 4)
        }
        .font(.title3.weight(.semibold))
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No Workspaces Found", systemImage: "folder.badge.questionmark")
        } description: {
            Text("Create a new workspace to get started, or adjust your search filters.")
        } actions: {
            Button("New Workspace") {
                browserVM.showCreateSheet = true
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }

    private func selectWorkspace(_ workspace: WorkspaceConfig) {
        viewModel.selectedWorkspaceId = workspace.id
        tabManager.openTab(TabItem(
            title: "Spec",
            icon: "doc.text",
            contentType: .spec(workspaceId: workspace.id),
            workspaceId: workspace.id
        ))
    }
}

