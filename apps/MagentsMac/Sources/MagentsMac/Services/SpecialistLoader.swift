import Foundation

/// Loads specialist definitions from markdown files with YAML frontmatter.
struct SpecialistLoader: Sendable {

    /// Directories to scan for specialist `.md` files.
    private var builtinDirectory: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.magents/specialists-builtin"
    }

    private var userDirectory: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/.magents/specialists"
    }

    // MARK: - Public

    func loadSpecialists() async -> [SpecialistDefinition] {
        var results: [SpecialistDefinition] = []
        results.append(contentsOf: loadFromDirectory(builtinDirectory, source: .builtin))
        results.append(contentsOf: loadFromDirectory(userDirectory, source: .user))

        // If no specialists found on disk, use built-in defaults
        if results.isEmpty {
            results = defaultSpecialists()
        }

        return results
    }

    /// Hardcoded fallback specialists when no `.md` files are found on disk.
    private func defaultSpecialists() -> [SpecialistDefinition] {
        [
            SpecialistDefinition(id: "developer", name: "Developer", description: "Plans then implements by itself", modelTier: "smart", roleReminder: nil, defaultModel: "opencode/claude-opus-4-6", systemPrompt: "", source: .builtin),
            SpecialistDefinition(id: "implementor", name: "Implementor", description: "Executes implementation tasks, writes code", modelTier: "smart", roleReminder: nil, defaultModel: "opencode/claude-opus-4-6", systemPrompt: "", source: .builtin),
            SpecialistDefinition(id: "coordinator", name: "Coordinator", description: "Plans work, breaks down tasks, coordinates sub-agents", modelTier: "smart", roleReminder: nil, defaultModel: "opencode/claude-opus-4-6", systemPrompt: "", source: .builtin),
            SpecialistDefinition(id: "verifier", name: "Verifier", description: "Reviews work and verifies completeness", modelTier: "smart", roleReminder: nil, defaultModel: "opencode/claude-opus-4-6", systemPrompt: "", source: .builtin),
            SpecialistDefinition(id: "pr-reviewer", name: "PR Reviewer", description: "Reviews pull requests with actionable feedback", modelTier: "smart", roleReminder: nil, defaultModel: "opencode/claude-opus-4-6", systemPrompt: "", source: .builtin),
            SpecialistDefinition(id: "ui-designer", name: "UI Designer", description: "Creates elegant, accessible user interfaces", modelTier: "fast", roleReminder: nil, defaultModel: "opencode/claude-opus-4-6", systemPrompt: "", source: .builtin),
        ]
    }

    // MARK: - Private

    private func loadFromDirectory(_ directory: String, source: SpecialistSource) -> [SpecialistDefinition] {
        let fm = FileManager.default
        guard fm.fileExists(atPath: directory) else { return [] }

        guard let files = try? fm.contentsOfDirectory(atPath: directory) else { return [] }

        return files
            .filter { $0.hasSuffix(".md") }
            .compactMap { file -> SpecialistDefinition? in
                let path = "\(directory)/\(file)"
                return parseSpecialistFile(at: path, filename: file, source: source)
            }
    }

    private func parseSpecialistFile(at path: String, filename: String, source: SpecialistSource) -> SpecialistDefinition? {
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }

        // Split on YAML frontmatter delimiters (---)
        let parts = content.components(separatedBy: "---")
        guard parts.count >= 3 else { return nil }

        let yamlBlock = parts[1]
        let systemPrompt = parts.dropFirst(2).joined(separator: "---").trimmingCharacters(in: .whitespacesAndNewlines)

        // Parse simple YAML key-value pairs
        let frontmatter = parseYAMLFrontmatter(yamlBlock)

        guard let name = frontmatter["name"] else { return nil }

        let id = String(filename.dropLast(3)) // remove .md

        return SpecialistDefinition(
            id: id,
            name: name,
            description: frontmatter["description"] ?? "",
            modelTier: frontmatter["modelTier"],
            roleReminder: frontmatter["roleReminder"],
            defaultModel: frontmatter["defaultModel"],
            systemPrompt: systemPrompt,
            source: source
        )
    }

    /// Simple YAML parser: extracts `key: "value"` or `key: value` pairs.
    private func parseYAMLFrontmatter(_ yaml: String) -> [String: String] {
        var result: [String: String] = [:]
        for line in yaml.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }
            guard let colonIndex = trimmed.firstIndex(of: ":") else { continue }

            let key = String(trimmed[trimmed.startIndex..<colonIndex]).trimmingCharacters(in: .whitespaces)
            var value = String(trimmed[trimmed.index(after: colonIndex)...]).trimmingCharacters(in: .whitespaces)

            // Strip surrounding quotes
            if value.hasPrefix("\"") && value.hasSuffix("\"") && value.count >= 2 {
                value = String(value.dropFirst().dropLast())
            }

            result[key] = value
        }
        return result
    }
}

