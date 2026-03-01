import SwiftUI

/// Modal sheet for creating a new agent within a workspace.
struct CreateAgentSheet: View {
    let workspacePath: String
    let workspaceId: String

    @Environment(\.dismiss) private var dismiss
    @Environment(WorkspaceViewModel.self) private var workspaceVM
    @Environment(TabManager.self) private var tabManager
    @Environment(ServerManager.self) private var serverManager

    @State private var viewModel = AgentCreationViewModel()

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Text("New Agent")
                    .font(.headline)
                Spacer()
                Button("Create") {
                    Task { await createAgent() }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(viewModel.isCreating)
            }
            .padding()

            Divider()

            // Content — use ScrollView + GroupBox instead of Form to avoid
            // macOS layout collapse when Form is inside a VStack
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    GroupBox("Specialist") {
                        Picker("Type", selection: $viewModel.selectedSpecialist) {
                            Text("None (Custom)")
                                .tag(nil as SpecialistSummary?)

                            ForEach(viewModel.specialists) { specialist in
                                Text(specialist.name)
                                    .tag(specialist as SpecialistSummary?)
                            }
                        }
                        .pickerStyle(.menu)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    GroupBox("Details") {
                        VStack(alignment: .leading, spacing: 12) {
                            LabeledContent("Label") {
                                TextField("Agent name", text: $viewModel.label)
                                    .textFieldStyle(.roundedBorder)
                            }

                            Picker("Model", selection: $viewModel.model) {
                                Text("claude-opus-4.6 (Zen)").tag("opencode/claude-opus-4-6")
                                Text("claude-sonnet-4").tag("opencode/claude-sonnet-4-20250514")
                                Text("claude-opus-4").tag("opencode/claude-opus-4-20250514")
                                Text("claude-haiku-4").tag("opencode/claude-haiku-4-20250514")
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if let error = viewModel.error {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .padding(.horizontal)
                    }
                }
                .padding()
            }
        }
        .frame(width: 450, height: 350)
        .task {
            await viewModel.loadSpecialists(serverManager: serverManager, workspacePath: workspacePath)
        }
    }

    // MARK: - Actions

    private func createAgent() async {
        do {
            let agent = try await viewModel.createAgent(workspacePath: workspacePath, serverManager: serverManager)

            // Refresh agents list
            workspaceVM.agentsForWorkspace[workspaceId] = nil
            if let workspace = workspaceVM.workspaces.first(where: { $0.id == workspaceId }) {
                await workspaceVM.loadAgents(for: workspace)
            }

            // Open chat tab
            tabManager.openTab(TabItem(
                title: agent.label,
                icon: "bubble.left.fill",
                contentType: .chat(agentId: agent.agentId),
                workspaceId: workspaceId
            ))

            dismiss()
        } catch {
            viewModel.error = error.localizedDescription
        }
    }
}

