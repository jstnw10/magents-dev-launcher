import Foundation
import Observation

/// Caches `ChatViewModel` instances by agentId so they survive SwiftUI view
/// recreation (e.g. tab switches). Inject as `@Environment` in the app root.
@MainActor
@Observable
final class ChatViewModelStore {
    private var viewModels: [String: ChatViewModel] = [:]

    /// Returns an existing ViewModel for the agent, or creates and caches a new one.
    func viewModel(agentId: String, sessionId: String, workspacePath: String) -> ChatViewModel {
        if let existing = viewModels[agentId] {
            return existing
        }
        let vm = ChatViewModel(agentId: agentId, sessionId: sessionId, workspacePath: workspacePath)
        viewModels[agentId] = vm
        return vm
    }

    /// Disconnects and removes the cached ViewModel for the given agent.
    func remove(agentId: String) {
        viewModels[agentId]?.disconnectWebSocket()
        viewModels[agentId] = nil
    }
}

