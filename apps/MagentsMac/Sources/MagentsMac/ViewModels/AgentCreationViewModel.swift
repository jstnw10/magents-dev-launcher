import Foundation
import Observation

/// Drives the Create Agent sheet: loads specialists from agent-manager, validates input,
/// creates agent via agent-manager HTTP API.
/// The macOS app never touches prompts — agent-manager handles specialist resolution.
@MainActor
@Observable
final class AgentCreationViewModel {

    var specialists: [SpecialistSummary] = []
    var selectedSpecialist: SpecialistSummary? {
        didSet { applySpecialistDefaults() }
    }
    var label: String = ""
    var model: String = "opencode/claude-opus-4-6"
    var isCreating = false
    var error: String?

    // MARK: - Load

    /// Loads specialists from agent-manager HTTP API.
    func loadSpecialists(serverManager: ServerManager, workspacePath: String) async {
        guard let baseURL = serverManager.agentManagerURL(for: workspacePath) else {
            // Fallback: no agent-manager running yet
            return
        }
        do {
            let client = AgentManagerClient(baseURL: baseURL)
            specialists = try await client.listSpecialists()
        } catch {
            print("[AgentCreationVM] Failed to load specialists: \(error)")
        }
    }

    // MARK: - Create

    /// Creates an agent via agent-manager HTTP API.
    /// Agent-manager auto-resolves specialist prompts from specialistId.
    func createAgent(workspacePath: String, serverManager: ServerManager) async throws -> AgentMetadata {
        isCreating = true
        error = nil
        defer { isCreating = false }

        // Ensure server is running
        _ = try await serverManager.getOrStart(workspacePath: workspacePath)

        guard let baseURL = serverManager.agentManagerURL(for: workspacePath) else {
            throw AgentCreationError.serverNotRunning
        }

        let client = AgentManagerClient(baseURL: baseURL)
        let agentLabel = label.isEmpty ? (selectedSpecialist?.name ?? "Agent") : label
        let metadata = try await client.createAgent(
            label: agentLabel,
            model: model.isEmpty ? nil : model,
            specialistId: selectedSpecialist?.id
        )

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
        model = "opencode/claude-opus-4-6"
        error = nil
    }
}

enum AgentCreationError: Error, LocalizedError {
    case serverNotRunning

    var errorDescription: String? {
        switch self {
        case .serverNotRunning:
            return "Agent-manager server is not running. Start the server first."
        }
    }
}

