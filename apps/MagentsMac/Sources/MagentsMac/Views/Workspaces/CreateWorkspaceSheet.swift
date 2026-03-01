import SwiftUI
import AppKit

@MainActor
@Observable
final class CreateWorkspaceViewModel {
    var repositoryPath: String = ""
    var title: String = ""
    var baseBranch: String = "main"
    var availableBranches: [String] = ["main"]
    var setupCommand: String = ""
    var isCreating = false
    var errorMessage: String?
    var isValidRepo = false

    func selectRepository() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Select a Git repository"
        panel.prompt = "Select"

        guard panel.runModal() == .OK, let url = panel.url else { return }
        repositoryPath = url.path

        // Validate git repo
        let gitDir = url.appendingPathComponent(".git").path
        isValidRepo = FileManager.default.fileExists(atPath: gitDir)

        if isValidRepo {
            Task {
                await loadBranches()
                detectPackageManager()
            }
        }
    }

    func loadBranches() async {
        guard !repositoryPath.isEmpty else { return }
        do {
            let result = try await ShellRunner.run(
                "git branch -a --format='%(refname:short)'",
                workingDirectory: repositoryPath
            )
            let branches = result.output
                .split(separator: "\n")
                .map { String($0).trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            if !branches.isEmpty {
                availableBranches = branches
                if branches.contains("main") {
                    baseBranch = "main"
                } else if branches.contains("master") {
                    baseBranch = "master"
                } else {
                    baseBranch = branches[0]
                }
            }
        } catch {
            print("Failed to load branches: \(error)")
        }
    }

    func detectPackageManager() {
        let fm = FileManager.default
        let lockfiles: [(String, String)] = [
            ("bun.lockb", "bun install"),
            ("pnpm-lock.yaml", "pnpm install"),
            ("yarn.lock", "yarn install"),
            ("package-lock.json", "npm install"),
        ]
        for (file, command) in lockfiles {
            let path = "\(repositoryPath)/\(file)"
            if fm.fileExists(atPath: path) {
                setupCommand = command
                return
            }
        }
        setupCommand = ""
    }

    func createWorkspace() async -> WorkspaceConfig? {
        isCreating = true
        errorMessage = nil
        defer { isCreating = false }

        do {
            let wfm = WorkspaceFileManager()
            let config = try await wfm.createWorkspace(
                repositoryPath: repositoryPath,
                title: title.isEmpty ? nil : title,
                baseRef: baseBranch,
                setupCommand: setupCommand.isEmpty ? nil : setupCommand
            )
            return config
        } catch {
            errorMessage = "Creation failed: \(error.localizedDescription)"
            return nil
        }
    }
}

struct CreateWorkspaceSheet: View {
    @Environment(WorkspaceViewModel.self) private var viewModel
    @Environment(TabManager.self) private var tabManager
    @Environment(ServerManager.self) private var serverManager
    @Environment(\.dismiss) private var dismiss
    @State private var createVM = CreateWorkspaceViewModel()

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("New Workspace")
                    .font(.title2.weight(.semibold))
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                        .font(.title3)
                }
                .buttonStyle(.plain)
            }
            .padding()

            Divider()

            Form {
                // Repository
                Section("Repository") {
                    HStack {
                        Button("Select Repository…") {
                            createVM.selectRepository()
                        }
                        Spacer()
                        if createVM.isValidRepo {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        }
                    }
                    if !createVM.repositoryPath.isEmpty {
                        Text(createVM.repositoryPath)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    if !createVM.repositoryPath.isEmpty && !createVM.isValidRepo {
                        Text("Not a valid Git repository")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }

                // Title
                Section("Title") {
                    TextField("Auto-generated if empty", text: $createVM.title)
                }

                // Base Branch
                Section("Base Branch") {
                    Picker("Branch", selection: $createVM.baseBranch) {
                        ForEach(createVM.availableBranches, id: \.self) { branch in
                            Text(branch).tag(branch)
                        }
                    }
                    .pickerStyle(.menu)
                    .disabled(!createVM.isValidRepo)
                }

                // Setup Command
                Section("Setup Command") {
                    TextField("e.g. npm install", text: $createVM.setupCommand)
                        .disabled(!createVM.isValidRepo)
                }

                // Error
                if let error = createVM.errorMessage {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }
            }
            .formStyle(.grouped)

            Divider()

            // Footer
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)

                Button {
                    Task {
                        guard let config = await createVM.createWorkspace() else { return }
                        await viewModel.loadWorkspaces()

                        // Auto-create Coordinator agent
                        await createCoordinatorAgent(for: config)

                        dismiss()
                    }
                } label: {
                    if createVM.isCreating {
                        ProgressView()
                            .controlSize(.small)
                            .padding(.horizontal, 8)
                    } else {
                        Text("Create")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!createVM.isValidRepo || createVM.isCreating)
                .keyboardShortcut(.defaultAction)
            }
            .padding()
        }
        .frame(width: 480, height: 520)
    }

    // MARK: - Auto-create Coordinator Agent

    private func createCoordinatorAgent(for config: WorkspaceConfig) async {
        do {
            // 1. Get or start server
            let serverInfo = try await serverManager.getOrStart(workspacePath: config.path)

            // 2. Create OpenCode session
            let client = OpenCodeClient(serverInfo: serverInfo)
            let session = try await client.createSession(
                directory: config.path,
                title: "Coordinator"
            )

            // 3. Load coordinator specialist prompt
            let loader = SpecialistLoader()
            let specialists = await loader.loadSpecialists()
            let coordinatorSpec = specialists.first { $0.id == "coordinator" }

            // 4. Build agent metadata
            let agentId = UUID().uuidString.lowercased()
            let metadata = AgentMetadata(
                agentId: agentId,
                sessionId: session.id,
                label: "Coordinator",
                model: "opencode/claude-opus-4-6",
                agent: nil,
                specialistId: "coordinator",
                systemPrompt: coordinatorSpec?.systemPrompt,
                createdAt: ISO8601DateFormatter().string(from: Date())
            )

            // 5. Write agent JSON to disk
            let agentsDir = "\(config.path)/.workspace/opencode/agents"
            let fm = FileManager.default
            if !fm.fileExists(atPath: agentsDir) {
                try fm.createDirectory(atPath: agentsDir, withIntermediateDirectories: true)
            }
            let filePath = "\(agentsDir)/\(agentId).json"
            let data = try JSONEncoder().encode(metadata)
            try data.write(to: URL(fileURLWithPath: filePath))

            // 6. Refresh agents list
            viewModel.agentsForWorkspace[config.id] = nil
            if let workspace = viewModel.workspaces.first(where: { $0.id == config.id }) {
                await viewModel.loadAgents(for: workspace)
            }

            // 7. Select workspace and open chat tab
            viewModel.selectedWorkspaceId = config.id
            tabManager.openTab(TabItem(
                title: "Coordinator",
                icon: "bubble.left.fill",
                contentType: .chat(agentId: agentId),
                workspaceId: config.id
            ))
        } catch {
            print("Failed to auto-create Coordinator agent: \(error)")
        }
    }
}

