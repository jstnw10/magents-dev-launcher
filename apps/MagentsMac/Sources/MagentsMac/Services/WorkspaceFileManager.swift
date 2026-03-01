import Foundation

/// Reads workspace data from disk following the magents directory conventions.
struct WorkspaceFileManager: Sendable {

    /// Returns the root directory for all workspaces: `~/.magents/workspaces`
    func getWorkspacesRoot() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.magents/workspaces"
    }

    /// Lists all workspaces by scanning `~/.magents/workspaces/{id}/{repo}/.workspace/workspace.json`.
    func listWorkspaces() async throws -> [WorkspaceConfig] {
        let fm = FileManager.default
        var workspaces: [WorkspaceConfig] = []

        // 1. Scan ~/.magents/workspaces/{id}/{repo}/.workspace/workspace.json
        let magentsRoot = getWorkspacesRoot()
        if fm.fileExists(atPath: magentsRoot) {
            let workspaceIds = try fm.contentsOfDirectory(atPath: magentsRoot)
            for workspaceId in workspaceIds {
                let workspaceDir = "\(magentsRoot)/\(workspaceId)"
                guard isDirectory(workspaceDir, fm: fm) else { continue }

                let repos = try fm.contentsOfDirectory(atPath: workspaceDir)
                for repo in repos {
                    let repoDir = "\(workspaceDir)/\(repo)"
                    let configPath = "\(repoDir)/.workspace/workspace.json"
                    if fm.fileExists(atPath: configPath) {
                        if let config = try? decodeFile(WorkspaceConfig.self, at: configPath) {
                            workspaces.append(config)
                        }
                    }
                }
            }
        }

        return workspaces
    }

    /// Reads a single workspace config from a JSON file path.
    func readWorkspaceConfig(at path: String) async throws -> WorkspaceConfig {
        try decodeFile(WorkspaceConfig.self, at: path)
    }

    /// Lists agent metadata files from `.workspace/opencode/agents/*.json`
    func listAgents(workspacePath: String) async throws -> [AgentMetadata] {
        let fm = FileManager.default
        let agentsDir = "\(workspacePath)/.workspace/opencode/agents"
        guard fm.fileExists(atPath: agentsDir) else { return [] }

        let files = try fm.contentsOfDirectory(atPath: agentsDir)
        return files
            .filter { $0.hasSuffix(".json") }
            .compactMap { file -> AgentMetadata? in
                let path = "\(agentsDir)/\(file)"
                return try? decodeFile(AgentMetadata.self, at: path)
            }
    }

    /// Lists all notes from `.workspace/notes/*.md`
    func listNotes(workspacePath: String) async throws -> [Note] {
        let fm = FileManager.default
        let notesDir = "\(workspacePath)/.workspace/notes"
        guard fm.fileExists(atPath: notesDir) else { return [] }

        let files = try fm.contentsOfDirectory(atPath: notesDir)
        return files
            .filter { $0.hasSuffix(".md") }
            .compactMap { file -> Note? in
                let path = "\(notesDir)/\(file)"
                return try? parseNoteFile(at: path)
            }
    }

    /// Reads a single note by ID from `.workspace/notes/{id}.md`
    func readNote(workspacePath: String, id: String) async throws -> Note {
        let path = "\(workspacePath)/.workspace/notes/\(id).md"
        return try parseNoteFile(at: path)
    }

    /// Reads server info from `.workspace/opencode/server.json`, returns nil if not found.
    func readServerInfo(workspacePath: String) async throws -> ServerInfo? {
        let fm = FileManager.default
        let path = "\(workspacePath)/.workspace/opencode/server.json"
        guard fm.fileExists(atPath: path) else { return nil }
        return try decodeFile(ServerInfo.self, at: path)
    }

    // MARK: - Workspace Creation

    /// Generate a workspace ID in adjective-animal format, matching the CLI convention.
    func generateWorkspaceId(excluding existingIds: Set<String> = []) -> String {
        let adjectives = [
            "agile", "bold", "brave", "bright", "calm",
            "clever", "cool", "daring", "eager", "fair",
            "fast", "fierce", "fond", "frank", "fresh",
            "gentle", "glad", "grand", "happy", "hardy",
            "hasty", "honest", "jolly", "keen", "kind",
            "lively", "loyal", "merry", "mighty", "modest",
            "noble", "plain", "plucky", "polite", "proud",
            "quick", "quiet", "rapid", "ready", "sharp",
            "sleek", "smart", "snug", "steady", "stout",
            "sunny", "swift", "tender", "usual", "vivid",
        ]
        let animals = [
            "alpaca", "badger", "bobcat", "bison", "canary",
            "condor", "cougar", "crane", "dingo", "eagle",
            "falcon", "ferret", "finch", "fox", "gecko",
            "gibbon", "heron", "hornet", "husky", "ibis",
            "iguana", "jackal", "jaguar", "koala", "lemur",
            "leopon", "lizard", "lynx", "macaw", "marten",
            "mink", "moose", "newt", "ocelot", "otter",
            "parrot", "pelican", "puma", "quail", "raven",
            "robin", "salmon", "shark", "shrew", "sloth",
            "spider", "stork", "tiger", "toucan", "wombat",
        ]

        let maxAttempts = adjectives.count * animals.count
        for _ in 0..<maxAttempts {
            let adj = adjectives.randomElement()!
            let animal = animals.randomElement()!
            let id = "\(adj)-\(animal)"
            if !existingIds.contains(id) { return id }
        }
        // Fallback with random suffix
        let adj = adjectives.randomElement()!
        let animal = animals.randomElement()!
        return "\(adj)-\(animal)-\(UUID().uuidString.prefix(4).lowercased())"
    }

    /// Create a new workspace with a git worktree, matching the CLI's `workspace create` flow.
    func createWorkspace(
        repositoryPath: String,
        title: String?,
        baseRef: String,
        setupCommand: String?
    ) async throws -> WorkspaceConfig {
        // 1. Generate unique ID
        let existing = try await listWorkspaces()
        let existingIds = Set(existing.map { $0.id })
        let workspaceId = generateWorkspaceId(excluding: existingIds)

        // 2. Compute paths
        let repoName = URL(fileURLWithPath: repositoryPath).lastPathComponent
        let root = getWorkspacesRoot()
        let workspacePath = "\(root)/\(workspaceId)/\(repoName)"

        // 3. Resolve base commit SHA
        let revParseResult = try await ShellRunner.run(
            "git rev-parse '\(baseRef)'",
            workingDirectory: repositoryPath
        )
        guard revParseResult.exitCode == 0 else {
            throw WorkspaceCreationError.invalidBaseRef(baseRef)
        }
        let baseCommitSha = revParseResult.output.trimmingCharacters(in: .whitespacesAndNewlines)

        // 4. Create git worktree with a new branch
        let branch = "magents/\(workspaceId)"
        let worktreeResult = try await ShellRunner.run(
            "git worktree add '\(workspacePath)' -b '\(branch)' '\(baseRef)'",
            workingDirectory: repositoryPath
        )
        guard worktreeResult.exitCode == 0 else {
            throw WorkspaceCreationError.worktreeFailed(worktreeResult.output)
        }

        // 5. Create .workspace directory structure
        let wsDir = "\(workspacePath)/.workspace"
        try FileManager.default.createDirectory(atPath: "\(wsDir)/logs", withIntermediateDirectories: true)

        // Create notes directory and default spec
        let notesDir = "\(wsDir)/notes"
        try FileManager.default.createDirectory(atPath: notesDir, withIntermediateDirectories: true)

        // Create default spec.md with YAML frontmatter
        let specContent = """
        ---
        id: spec
        title: Spec
        tags: [spec]
        pinned: true
        created: "\(ISO8601DateFormatter().string(from: Date()))"
        ---

        ## Goal

        _Describe the goal of this workspace._
        """
        try specContent.write(toFile: "\(notesDir)/spec.md", atomically: true, encoding: .utf8)

        // 5b. Generate prompt templates in .workspace/prompts/
        try PromptTemplateManager().generateTemplates(workspacePath: workspacePath)

        // 6. Parse repo owner/name from git remote
        var repoOwner: String?
        var repoNameFromRemote: String?
        if let remoteResult = try? await ShellRunner.run(
            "git remote get-url origin",
            workingDirectory: repositoryPath
        ), remoteResult.exitCode == 0 {
            let url = remoteResult.output.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleaned = url.replacingOccurrences(of: ".git", with: "")
            let parts = cleaned.split(separator: "/")
            if parts.count >= 2 {
                repoNameFromRemote = String(parts.last!)
                var owner = String(parts[parts.count - 2])
                // Handle ssh format: git@github.com:owner
                if owner.contains(":") {
                    owner = String(owner.split(separator: ":").last!)
                }
                repoOwner = owner
            }
        }

        // 7. Write workspace.json
        let now = ISO8601DateFormatter().string(from: Date())
        let config = WorkspaceConfig(
            id: workspaceId,
            title: (title?.isEmpty ?? true) ? workspaceId : title!,
            branch: branch,
            baseRef: baseRef,
            baseCommitSha: baseCommitSha,
            status: .active,
            createdAt: now,
            updatedAt: now,
            path: workspacePath,
            repositoryPath: repositoryPath,
            repositoryOwner: repoOwner,
            repositoryName: repoNameFromRemote ?? repoName,
            worktreePath: workspacePath,
            tags: [],
            archived: nil,
            archivedAt: nil
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(config)
        try data.write(to: URL(fileURLWithPath: "\(wsDir)/workspace.json"))

        // 8. Run setup command if provided
        if let setup = setupCommand, !setup.isEmpty {
            _ = try? await ShellRunner.run(setup, workingDirectory: workspacePath)
        }

        return config
    }

    // MARK: - Archive / Destroy

    /// Archive a workspace by updating its config status.
    func archiveWorkspace(at workspacePath: String) async throws {
        let configPath = "\(workspacePath)/.workspace/workspace.json"
        var config = try decodeFile(WorkspaceConfig.self, at: configPath)
        let now = ISO8601DateFormatter().string(from: Date())
        config.status = .archived
        config.archived = true
        config.archivedAt = now
        config.updatedAt = now

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(config)
        try data.write(to: URL(fileURLWithPath: configPath))
    }

    /// Unarchive a workspace by setting its status back to active.
    func unarchiveWorkspace(at workspacePath: String) async throws {
        let configPath = "\(workspacePath)/.workspace/workspace.json"
        var config = try decodeFile(WorkspaceConfig.self, at: configPath)
        let now = ISO8601DateFormatter().string(from: Date())
        config.status = .active
        config.archived = nil
        config.archivedAt = nil
        config.updatedAt = now

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(config)
        try data.write(to: URL(fileURLWithPath: configPath))
    }

    /// Destroy a workspace: remove the git worktree and delete the workspace directory.
    func destroyWorkspace(_ config: WorkspaceConfig) async throws {
        // Remove git worktree if paths are available
        if let worktreePath = config.worktreePath, let repositoryPath = config.repositoryPath {
            _ = try? await ShellRunner.run(
                "git worktree remove '\(worktreePath)' --force",
                workingDirectory: repositoryPath
            )
        }
        // Remove workspace directory (parent of repo-name dir)
        let workspaceDir = URL(fileURLWithPath: config.path).deletingLastPathComponent().path
        try? FileManager.default.removeItem(atPath: workspaceDir)
    }

    // MARK: - Note Parsing

    /// Parses a note `.md` file with YAML frontmatter.
    private func parseNoteFile(at path: String) throws -> Note {
        let content = try String(contentsOfFile: path, encoding: .utf8)

        // Split frontmatter from body
        guard content.hasPrefix("---\n") || content.hasPrefix("---\r\n") else {
            throw NSError(domain: "WorkspaceFileManager", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Note file missing YAML frontmatter"])
        }

        // Find the closing ---
        let lines = content.components(separatedBy: "\n")
        var frontmatterEnd = -1
        for i in 1..<lines.count {
            if lines[i].trimmingCharacters(in: .whitespaces) == "---" {
                frontmatterEnd = i
                break
            }
        }

        guard frontmatterEnd > 0 else {
            throw NSError(domain: "WorkspaceFileManager", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Note file has unclosed YAML frontmatter"])
        }

        let frontmatterLines = lines[1..<frontmatterEnd]
        let bodyLines = lines[(frontmatterEnd + 1)...]
        let body = bodyLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)

        // Parse YAML frontmatter (simple key-value parsing)
        var id = ""
        var title = ""
        var tags: [String] = []
        var createdAt = ""
        var updatedAt = ""
        var taskStatus: String?
        var acceptanceCriteria: [String]?
        var inTask = false
        var inAcceptanceCriteria = false

        for line in frontmatterLines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("- ") && inAcceptanceCriteria {
                let item = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                if acceptanceCriteria == nil { acceptanceCriteria = [] }
                acceptanceCriteria?.append(item)
                continue
            }

            if trimmed.hasPrefix("- ") { continue }

            // Reset nested state when we hit a top-level key
            if !line.hasPrefix(" ") && !line.hasPrefix("\t") {
                if !trimmed.hasPrefix("status:") { inTask = false }
                inAcceptanceCriteria = false
            }

            if trimmed.hasPrefix("id:") {
                id = extractYAMLValue(trimmed, key: "id")
            } else if trimmed.hasPrefix("title:") {
                title = extractYAMLValue(trimmed, key: "title")
            } else if trimmed.hasPrefix("tags:") {
                let value = extractYAMLValue(trimmed, key: "tags")
                if value.hasPrefix("[") && value.hasSuffix("]") {
                    let inner = String(value.dropFirst().dropLast())
                    tags = inner.components(separatedBy: ",").map {
                        $0.trimmingCharacters(in: .whitespaces)
                    }.filter { !$0.isEmpty }
                }
            } else if trimmed.hasPrefix("created:") {
                createdAt = extractYAMLValue(trimmed, key: "created")
            } else if trimmed.hasPrefix("updated:") {
                updatedAt = extractYAMLValue(trimmed, key: "updated")
            } else if trimmed == "task:" {
                inTask = true
            } else if inTask && trimmed.hasPrefix("status:") {
                taskStatus = extractYAMLValue(trimmed, key: "status")
            } else if inTask && trimmed.hasPrefix("acceptanceCriteria:") {
                inAcceptanceCriteria = true
            }
        }

        if updatedAt.isEmpty { updatedAt = createdAt }

        var taskMetadata: TaskMetadata?
        if let status = taskStatus {
            taskMetadata = TaskMetadata(
                status: status,
                acceptanceCriteria: acceptanceCriteria
            )
        }

        return Note(
            id: id,
            title: title,
            content: body,
            tags: tags,
            createdAt: createdAt,
            updatedAt: updatedAt,
            taskMetadata: taskMetadata
        )
    }

    /// Extracts a simple YAML value, stripping quotes.
    private func extractYAMLValue(_ line: String, key: String) -> String {
        let value = String(line.dropFirst(key.count + 1)).trimmingCharacters(in: .whitespaces)
        if (value.hasPrefix("\"") && value.hasSuffix("\"")) ||
           (value.hasPrefix("'") && value.hasSuffix("'")) {
            return String(value.dropFirst().dropLast())
        }
        return value
    }

    // MARK: - Helpers

    private func decodeFile<T: Decodable>(_ type: T.Type, at path: String) throws -> T {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        return try JSONDecoder().decode(type, from: data)
    }

    private func isDirectory(_ path: String, fm: FileManager) -> Bool {
        var isDir: ObjCBool = false
        return fm.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
    }
}

/// Errors that can occur during workspace creation.
enum WorkspaceCreationError: Error, LocalizedError {
    case invalidBaseRef(String)
    case worktreeFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidBaseRef(let ref): return "Could not resolve base ref '\(ref)'"
        case .worktreeFailed(let msg): return "Failed to create worktree: \(msg)"
        }
    }
}

