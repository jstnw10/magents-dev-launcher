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

    func createWorkspace() async -> Bool {
        isCreating = true
        errorMessage = nil
        defer { isCreating = false }

        var cmd = "magents workspace create --repo \(shellEscape(repositoryPath))"
        if !title.isEmpty {
            cmd += " --title \(shellEscape(title))"
        }
        cmd += " --base-ref \(shellEscape(baseBranch))"

        do {
            let result = try await ShellRunner.run(cmd)
            if result.exitCode != 0 {
                errorMessage = "Creation failed: \(result.output)"
                return false
            }
            return true
        } catch {
            errorMessage = "Error: \(error.localizedDescription)"
            return false
        }
    }

    private func shellEscape(_ str: String) -> String {
        "'\(str.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}

struct CreateWorkspaceSheet: View {
    @Environment(WorkspaceViewModel.self) private var viewModel
    @Environment(TabManager.self) private var tabManager
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
                        let success = await createVM.createWorkspace()
                        if success {
                            await viewModel.loadWorkspaces()
                            dismiss()
                        }
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
}

