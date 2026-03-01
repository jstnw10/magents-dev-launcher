import Foundation
import Observation
import UserNotifications

@MainActor
@Observable
final class WorkspaceViewModel {
    var workspaces: [WorkspaceConfig] = []
    var selectedWorkspaceId: String?
    var selectedAgentId: String?
    var agentsForWorkspace: [String: [AgentMetadata]] = [:]
    var isLoading = false

    // SSE connection per workspace
    private var sseClients: [String: SSEClient] = [:]
    private var sseStreamingTasks: [String: Task<Void, Never>] = [:]
    private var reconnectTasks: [String: Task<Void, Never>] = [:]
    private var reconnectAttempts: [String: Int] = [:]

    // Agent status tracking
    var agentStatuses: [String: AgentStatus] = [:]

    // Event handlers for active ChatViewModels
    private var eventHandlers: [String: (SSEEvent) async -> Void] = [:]

    private let fileManager = WorkspaceFileManager()

    // MARK: - Computed Properties

    var activeWorkspaces: [WorkspaceConfig] {
        workspaces.filter { $0.status == .active }
    }

    var archivedWorkspaces: [WorkspaceConfig] {
        workspaces.filter { $0.status == .archived }
    }

    var selectedWorkspace: WorkspaceConfig? {
        guard let selectedWorkspaceId else { return nil }
        return workspaces.first { $0.id == selectedWorkspaceId }
    }

    // MARK: - Loading

    func loadWorkspaces() async {
        isLoading = true
        defer { isLoading = false }

        do {
            workspaces = try await fileManager.listWorkspaces()
        } catch {
            print("Failed to load workspaces: \(error)")
            workspaces = []
        }
    }

    func loadAgents(for workspace: WorkspaceConfig) async {
        guard agentsForWorkspace[workspace.id] == nil else { return }

        do {
            let agents = try await fileManager.listAgents(workspacePath: workspace.path)
            agentsForWorkspace[workspace.id] = agents
        } catch {
            print("Failed to load agents for \(workspace.title): \(error)")
            agentsForWorkspace[workspace.id] = []
        }
    }

    func agents(for workspace: WorkspaceConfig) -> [AgentMetadata] {
        agentsForWorkspace[workspace.id] ?? []
    }

    // MARK: - SSE Connection Management

    func connectSSE(for workspace: WorkspaceConfig, serverManager: ServerManager) async {
        guard sseClients[workspace.id] == nil else { return }

        do {
            let serverInfo = try await serverManager.getOrStart(workspacePath: workspace.path)
            let sseClient = SSEClient(baseURL: URL(string: serverInfo.url)!)
            sseClients[workspace.id] = sseClient
            let eventStream = sseClient.connect()
            let workspaceId = workspace.id
            let workspacePath = workspace.path

            sseStreamingTasks[workspace.id] = Task { [weak self] in
                for await event in eventStream {
                    guard let self = self else { break }
                    guard !Task.isCancelled else { break }
                    await self.handleSSEEvent(event, workspaceId: workspaceId)
                }

                // Connection ended — schedule reconnect
                await self?.scheduleReconnect(
                    workspaceId: workspaceId,
                    workspacePath: workspacePath,
                    serverManager: serverManager
                )
            }

            reconnectAttempts[workspace.id] = 0
            print("[WorkspaceVM] SSE connected for workspace \(workspace.id)")
        } catch {
            print("[WorkspaceVM] Failed to connect SSE for \(workspace.id): \(error)")
            scheduleReconnect(
                workspaceId: workspace.id,
                workspacePath: workspace.path,
                serverManager: serverManager
            )
        }
    }

    func disconnectSSE(for workspaceId: String) {
        reconnectTasks[workspaceId]?.cancel()
        reconnectTasks[workspaceId] = nil
        sseStreamingTasks[workspaceId]?.cancel()
        sseStreamingTasks[workspaceId] = nil
        sseClients[workspaceId]?.disconnect()
        sseClients[workspaceId] = nil
        reconnectAttempts[workspaceId] = nil
        print("[WorkspaceVM] SSE disconnected for workspace \(workspaceId)")
    }

    func disconnectAllSSE() {
        for workspaceId in Array(sseClients.keys) {
            disconnectSSE(for: workspaceId)
        }
    }

    private func scheduleReconnect(workspaceId: String, workspacePath: String, serverManager: ServerManager) {
        reconnectTasks[workspaceId]?.cancel()

        let attempts = reconnectAttempts[workspaceId] ?? 0
        let delay = min(pow(2.0, Double(attempts)), 30.0)
        reconnectAttempts[workspaceId] = attempts + 1
        print("[WorkspaceVM] Scheduling SSE reconnect for \(workspaceId) in \(delay)s (attempt \(attempts + 1))")

        // Clear stale client state so connectSSE will proceed
        sseClients[workspaceId]?.disconnect()
        sseClients[workspaceId] = nil

        reconnectTasks[workspaceId] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            guard let self = self,
                  let workspace = self.workspaces.first(where: { $0.id == workspaceId })
            else { return }
            await self.connectSSE(for: workspace, serverManager: serverManager)
        }
    }

    // MARK: - SSE Event Handling

    private func handleSSEEvent(_ event: SSEEvent, workspaceId: String) async {
        guard let jsonData = event.data.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any]
        else { return }

        let eventType = json["type"] as? String ?? ""
        let properties = json["properties"] as? [String: Any] ?? [:]

        // Extract sessionID from various event shapes
        let sessionID = properties["sessionID"] as? String
            ?? (properties["info"] as? [String: Any])?["sessionID"] as? String
            ?? (properties["part"] as? [String: Any])?["sessionID"] as? String

        // Handle session.status events for agent status tracking
        if eventType == "session.status",
           let sessionID = sessionID,
           let statusDict = properties["status"] as? [String: Any],
           let statusType = statusDict["type"] as? String {
            let status = AgentStatus(rawValue: statusType) ?? .idle
            agentStatuses[sessionID] = status

            // Update agent metadata in the agents list
            if var agents = agentsForWorkspace[workspaceId],
               let agentIndex = agents.firstIndex(where: { $0.sessionId == sessionID }) {
                agents[agentIndex].status = status
                agentsForWorkspace[workspaceId] = agents
            }
        }

        // Route event to active ChatViewModel if registered
        if let sessionID = sessionID,
           let handler = eventHandlers[sessionID] {
            await handler(event)
        } else if eventType == "message.updated",
                  let sessionID = sessionID,
                  let info = properties["info"] as? [String: Any],
                  let role = info["role"] as? String,
                  role == "assistant",
                  let time = info["time"] as? [String: Any],
                  time["completed"] != nil {
            // Agent finished work while tab is closed — show notification
            if let agent = findAgent(sessionId: sessionID, workspaceId: workspaceId) {
                showNotification(title: "Agent Finished", message: "\(agent.label) completed its work")
            }
        }
    }

    // MARK: - Event Handler Registration

    func registerEventHandler(sessionId: String, handler: @escaping (SSEEvent) async -> Void) {
        eventHandlers[sessionId] = handler
    }

    func unregisterEventHandler(sessionId: String) {
        eventHandlers[sessionId] = nil
    }

    /// Check if SSE is connected for a given workspace
    func isSSEConnected(for workspaceId: String) -> Bool {
        sseClients[workspaceId] != nil
    }

    // MARK: - Helpers

    private func findAgent(sessionId: String, workspaceId: String) -> AgentMetadata? {
        agentsForWorkspace[workspaceId]?.first { $0.sessionId == sessionId }
    }

    private func showNotification(title: String, message: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = message
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        center.add(request)
    }
}

