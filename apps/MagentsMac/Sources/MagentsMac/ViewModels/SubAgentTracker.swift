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

    /// Agent IDs that existed before the current turn started.
    private var knownAgentIds: Set<String> = []
    /// Whether tracking is active.
    private(set) var isTracking: Bool = false

    // MARK: - Tracking Lifecycle

    /// Start tracking sub-agents for a parent agent turn.
    /// Snapshots the current set of known agent IDs so new ones can be detected.
    func startTracking(parentAgentId: String, currentAgents: [AgentMetadata]) {
        knownAgentIds = Set(currentAgents.map(\.agentId))
        activeSubAgents = []
        isTracking = true
        print("[SubAgentTracker] Started tracking for parent \(parentAgentId), known agents: \(knownAgentIds.count)")
    }

    /// Check for newly created agents by comparing against the snapshot.
    /// Call this periodically while the parent agent is busy.
    func checkForNewAgents(agents: [AgentMetadata]) {
        guard isTracking else { return }

        for agent in agents {
            if !knownAgentIds.contains(agent.agentId),
               !activeSubAgents.contains(where: { $0.agentId == agent.agentId }) {
                let info = SubAgentInfo(
                    agentId: agent.agentId,
                    sessionId: agent.sessionId,
                    label: agent.label
                )
                activeSubAgents.append(info)
                print("[SubAgentTracker] Discovered new sub-agent: \(agent.label) (\(agent.agentId))")
            }
        }
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
        knownAgentIds = []
        activeSubAgents = []
        print("[SubAgentTracker] Stopped tracking")
    }
}

