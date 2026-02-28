import Foundation

/// Reads workspace data from disk following the magents directory conventions.
struct WorkspaceFileManager: Sendable {

    /// Returns the root directory for all workspaces: `~/.magents/workspaces`
    func getWorkspacesRoot() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.magents/workspaces"
    }

    /// Lists all workspaces by scanning `~/.magents/workspaces/{id}/{repo}/.workspace/workspace.json`
    func listWorkspaces() async throws -> [WorkspaceConfig] {
        let fm = FileManager.default
        let root = getWorkspacesRoot()
        guard fm.fileExists(atPath: root) else { return [] }

        var workspaces: [WorkspaceConfig] = []
        let workspaceIds = try fm.contentsOfDirectory(atPath: root)

        for workspaceId in workspaceIds {
            let workspaceDir = "\(root)/\(workspaceId)"
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

    /// Lists all notes from `.workspace/notes/*.json`
    func listNotes(workspacePath: String) async throws -> [Note] {
        let fm = FileManager.default
        let notesDir = "\(workspacePath)/.workspace/notes"
        guard fm.fileExists(atPath: notesDir) else { return [] }

        let files = try fm.contentsOfDirectory(atPath: notesDir)
        return files
            .filter { $0.hasSuffix(".json") }
            .compactMap { file -> Note? in
                let path = "\(notesDir)/\(file)"
                return try? decodeFile(Note.self, at: path)
            }
    }

    /// Reads a single note by ID from `.workspace/notes/{id}.json`
    func readNote(workspacePath: String, id: String) async throws -> Note {
        let path = "\(workspacePath)/.workspace/notes/\(id).json"
        return try decodeFile(Note.self, at: path)
    }

    /// Reads server info from `.workspace/opencode/server.json`, returns nil if not found.
    func readServerInfo(workspacePath: String) async throws -> ServerInfo? {
        let fm = FileManager.default
        let path = "\(workspacePath)/.workspace/opencode/server.json"
        guard fm.fileExists(atPath: path) else { return nil }
        return try decodeFile(ServerInfo.self, at: path)
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

