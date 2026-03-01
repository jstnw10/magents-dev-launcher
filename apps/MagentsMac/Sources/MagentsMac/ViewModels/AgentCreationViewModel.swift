import Foundation
import Observation

/// Drives the Create Agent sheet: loads specialists, validates input, creates agent.
@MainActor
@Observable
final class AgentCreationViewModel {

    var specialists: [SpecialistDefinition] = []
    var selectedSpecialist: SpecialistDefinition? {
        didSet { applySpecialistDefaults() }
    }
    var label: String = ""
    var model: String = ""
    var isCreating = false
    var error: String?

    private let loader = SpecialistLoader()

    // MARK: - Load

    func loadSpecialists() async {
        specialists = await loader.loadSpecialists()
    }

    // MARK: - Create

    /// Creates an agent, writes metadata to disk, and returns the metadata.
    /// Uses ServerManager to ensure the OpenCode server is running.
    func createAgent(workspacePath: String, serverManager: ServerManager) async throws -> AgentMetadata {
        isCreating = true
        error = nil
        defer { isCreating = false }

        // 1. Get or start server via ServerManager
        let serverInfo = try await serverManager.getOrStart(workspacePath: workspacePath)

        // 2. Create OpenCode session
        let client = OpenCodeClient(serverInfo: serverInfo)
        let session = try await client.createSession(
            directory: workspacePath,
            title: label.isEmpty ? "Agent" : label
        )

        // 3. Build metadata
        let agentId = UUID().uuidString.lowercased()
        let metadata = AgentMetadata(
            agentId: agentId,
            sessionId: session.id,
            label: label.isEmpty ? (selectedSpecialist?.name ?? "Agent") : label,
            model: model.isEmpty ? nil : model,
            agent: nil,
            specialistId: selectedSpecialist?.id,
            systemPrompt: selectedSpecialist?.systemPrompt,
            createdAt: ISO8601DateFormatter().string(from: Date())
        )

        // 4. Write to disk
        let agentsDir = "\(workspacePath)/.workspace/opencode/agents"
        let fm = FileManager.default
        if !fm.fileExists(atPath: agentsDir) {
            try fm.createDirectory(atPath: agentsDir, withIntermediateDirectories: true)
        }

        let filePath = "\(agentsDir)/\(agentId).json"
        let data = try JSONEncoder().encode(metadata)
        try data.write(to: URL(fileURLWithPath: filePath))

        return metadata
    }

    // MARK: - Helpers

    private func applySpecialistDefaults() {
        guard let specialist = selectedSpecialist else { return }
        if label.isEmpty || label == specialists.first(where: { $0.id != specialist.id })?.name {
            label = specialist.name
        }
        if let defaultModel = specialist.defaultModel {
            model = defaultModel
        }
    }

    /// Resets the form for reuse.
    func reset() {
        selectedSpecialist = nil
        label = ""
        model = ""
        error = nil
    }
}

enum AgentCreationError: Error, LocalizedError {
    case serverNotRunning

    var errorDescription: String? {
        switch self {
        case .serverNotRunning:
            return "OpenCode server is not running. Start the server first."
        }
    }
}

