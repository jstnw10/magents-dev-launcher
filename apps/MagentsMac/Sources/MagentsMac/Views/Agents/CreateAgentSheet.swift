import SwiftUI

/// Modal sheet for creating a new agent within a workspace.
struct CreateAgentSheet: View {
    let workspacePath: String
    let workspaceId: String

    @Environment(\.dismiss) private var dismiss
    @Environment(WorkspaceViewModel.self) private var workspaceVM
    @Environment(TabManager.self) private var tabManager

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

            Form {
                specialistSection
                detailsSection

                if let error = viewModel.error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
            }
            .formStyle(.grouped)
        }
        .frame(minWidth: 420, minHeight: 320)
        .task {
            await viewModel.loadSpecialists()
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var specialistSection: some View {
        Section("Specialist") {
            Picker("Type", selection: $viewModel.selectedSpecialist) {
                Text("None (Custom)")
                    .tag(nil as SpecialistDefinition?)

                ForEach(viewModel.specialists) { specialist in
                    VStack(alignment: .leading) {
                        Text(specialist.name)
                        Text(specialist.description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .tag(specialist as SpecialistDefinition?)
                }
            }
            .pickerStyle(.menu)
        }
    }

    @ViewBuilder
    private var detailsSection: some View {
        Section("Details") {
            TextField("Label", text: $viewModel.label, prompt: Text("Agent name"))

            Picker("Model", selection: $viewModel.model) {
                Text("Default").tag("")
                Text("claude-sonnet-4").tag("claude-sonnet-4-20250514")
                Text("claude-opus-4").tag("claude-opus-4-20250514")
                Text("claude-haiku-4").tag("claude-haiku-4-20250514")
            }
        }
    }

    // MARK: - Actions

    private func createAgent() async {
        do {
            let agent = try await viewModel.createAgent(workspacePath: workspacePath)

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

