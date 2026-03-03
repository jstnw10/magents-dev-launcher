import Foundation
import Observation

/// Information about a discovered sub-agent.
struct SubAgentInfo: Identifiable, Sendable {
    let agentId: String
    let sessionId: String
    let label: String
    var lastStreamingLine: String = ""
    var isComplete: Bool = false

    var id: String { agentId }
}

/// Tracks sub-agents spawned by a parent agent during a conversation turn.
/// Detects new agents by comparing snapshots and captures streaming text from events.
@MainActor
@Observable
final class SubAgentTracker {
    var activeSubAgents: [SubAgentInfo] = []

    /// The parent agent's ID.
    private var parentAgentId: String = ""
    /// Whether tracking is active.
    private(set) var isTracking: Bool = false

    // MARK: - Tracking Lifecycle

    /// Start tracking sub-agents for a parent agent turn.
    func startTracking(parentAgentId: String, parentSessionId: String) {
        self.parentAgentId = parentAgentId
        activeSubAgents = []
        isTracking = true
        print("[SubAgentTracker] Started tracking for parent \(parentAgentId) (session: \(parentSessionId))")
    }

    /// Check for new child sessions returned by the agent-server.
    /// Sessions with the parent's sessionId are definitively sub-agents.
    func checkForNewSessions(sessions: [SessionInfo]) {
        guard isTracking else { return }

        for session in sessions {
            // Skip already-tracked
            if activeSubAgents.contains(where: { $0.sessionId == session.id }) { continue }

            let info = SubAgentInfo(
                agentId: session.id,
                sessionId: session.id,
                label: session.title
            )
            activeSubAgents.append(info)
            print("[SubAgentTracker] Discovered sub-agent session: \(session.title) (\(session.id))")
        }

        print("[SubAgentTracker] After check: \(activeSubAgents.count) active sub-agents")
    }

    /// Handle a raw event routed from WorkspaceViewModel.
    /// Parses delta events for streaming text and session.status for completion.
    func handleEvent(eventData: SendableDict) {
        let dict = eventData.value
        let eventType = dict["type"] as? String ?? ""
        let properties = dict["properties"] as? [String: Any] ?? [:]

        // Extract sessionID
        let sessionID = properties["sessionID"] as? String
            ?? (properties["info"] as? [String: Any])?["sessionID"] as? String
            ?? (properties["part"] as? [String: Any])?["sessionID"] as? String

        guard let sessionID else { return }

        // Find the sub-agent this event belongs to
        guard let index = activeSubAgents.firstIndex(where: { $0.sessionId == sessionID }) else {
            return
        }

        switch eventType {
        case "message.part.delta":
            let field = properties["field"] as? String
            let delta = properties["delta"] as? String
            if field == "text", let delta, !delta.isEmpty {
                // Extract last line of the accumulated text for display
                let currentText = activeSubAgents[index].lastStreamingLine
                let combined = currentText + delta
                // Keep only the last meaningful line
                if let lastNewline = combined.lastIndex(of: "\n") {
                    let afterNewline = combined[combined.index(after: lastNewline)...]
                    activeSubAgents[index].lastStreamingLine = String(afterNewline)
                } else {
                    activeSubAgents[index].lastStreamingLine = combined
                }
                // Truncate to reasonable length for display
                if activeSubAgents[index].lastStreamingLine.count > 200 {
                    activeSubAgents[index].lastStreamingLine = String(
                        activeSubAgents[index].lastStreamingLine.suffix(200)
                    )
                }
            }

        case "session.status":
            if let statusDict = properties["status"] as? [String: Any],
               let statusType = statusDict["type"] as? String,
               statusType == "idle" {
                activeSubAgents[index].isComplete = true
                print("[SubAgentTracker] Sub-agent completed: \(activeSubAgents[index].label)")
            }

        default:
            break
        }
    }

    /// Stop tracking and clear state.
    func stopTracking() {
        isTracking = false
        activeSubAgents = []
        print("[SubAgentTracker] Stopped tracking")
    }
}

