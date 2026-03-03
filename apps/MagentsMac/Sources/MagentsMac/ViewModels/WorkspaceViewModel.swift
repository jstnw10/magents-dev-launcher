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

    // Session tree data (all OpenCode sessions per workspace)
    var sessionsForWorkspace: [String: [SessionInfo]] = [:]
    var sessionStatuses: [String: String] = [:]  // sessionId -> "idle" | "busy" | "retry"

    // WebSocket connection per workspace (to agent-server /events)
    private var workspaceWebSockets: [String: URLSessionWebSocketTask] = [:]
    private var workspaceWebSocketTasks: [String: Task<Void, Never>] = [:]
    private var reconnectTasks: [String: Task<Void, Never>] = [:]
    private var reconnectAttempts: [String: Int] = [:]
    private var restartCounts: [String: Int] = [:]

    // Agent status tracking
    var agentStatuses: [String: AgentStatus] = [:]

    // Event handlers for active ChatViewModels — keyed by sessionId
    private var eventHandlers: [String: @MainActor (SendableDict) -> Void] = [:]

    /// Handlers for session.created events, keyed by parent session ID
    private var sessionCreatedHandlers: [String: @MainActor @Sendable (SendableDict) -> Void] = [:]

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

    // MARK: - Session Tree

    func loadSessions(for workspace: WorkspaceConfig, serverManager: ServerManager, force: Bool = false) async {
        // Skip if already loaded (unless forced)
        if !force && sessionsForWorkspace[workspace.id] != nil { return }

        var baseURL = serverManager.agentManagerURL(for: workspace.path)

        // If no URL yet, try to start the agent-manager
        if baseURL == nil {
            do {
                _ = try await serverManager.getOrStart(workspacePath: workspace.path)
                baseURL = serverManager.agentManagerURL(for: workspace.path)
            } catch {
                print("[WorkspaceVM] Failed to start agent-manager for sessions: \(error)")
            }
        }

        guard let url = baseURL else {
            print("[WorkspaceVM] No agent-manager URL for loading sessions: \(workspace.title)")
            return
        }

        let client = AgentManagerClient(baseURL: url)
        do {
            let sessions = try await client.listSessions()
            sessionsForWorkspace[workspace.id] = sessions
            print("[WorkspaceVM] Loaded \(sessions.count) sessions for \(workspace.title)")
        } catch {
            print("[WorkspaceVM] Failed to load sessions for \(workspace.title): \(error)")
            sessionsForWorkspace[workspace.id] = []
        }
    }

    func sessions(for workspace: WorkspaceConfig) -> [SessionInfo] {
        sessionsForWorkspace[workspace.id] ?? []
    }

    /// Returns child sessions of a given parent
    func childSessions(parentId: String, for workspace: WorkspaceConfig) -> [SessionInfo] {
        sessions(for: workspace).filter { $0.parentID == parentId }
            .sorted { $0.time.created < $1.time.created }
    }

    // MARK: - Workspace Event Connection (WebSocket to agent-server)

    func connectWorkspaceEvents(for workspace: WorkspaceConfig, serverManager: ServerManager) async {
        guard workspaceWebSockets[workspace.id] == nil else { return }

        guard let agentManagerURL = serverManager.agentManagerURL(for: workspace.path) else {
            print("[WorkspaceVM] No agent-manager URL for \(workspace.id) — trying to start")
            do {
                _ = try await serverManager.getOrStart(workspacePath: workspace.path)
            } catch {
                print("[WorkspaceVM] Failed to start server for \(workspace.id): \(error)")
            }
            guard let url = serverManager.agentManagerURL(for: workspace.path) else {
                print("[WorkspaceVM] Still no agent-manager URL for \(workspace.id)")
                scheduleReconnect(
                    workspaceId: workspace.id,
                    workspacePath: workspace.path,
                    serverManager: serverManager
                )
                return
            }
            await connectWorkspaceEventsWithURL(url, workspace: workspace, serverManager: serverManager)
            return
        }

        await connectWorkspaceEventsWithURL(agentManagerURL, workspace: workspace, serverManager: serverManager)
    }

    private func connectWorkspaceEventsWithURL(_ agentManagerURL: URL, workspace: WorkspaceConfig, serverManager: ServerManager) async {
        var components = URLComponents(url: agentManagerURL, resolvingAgainstBaseURL: false)!
        components.scheme = agentManagerURL.scheme == "https" ? "wss" : "ws"
        components.path = "/events"
        guard let wsURL = components.url else {
            print("[WorkspaceVM] Failed to construct WebSocket URL for \(workspace.id)")
            return
        }

        let session = URLSession(configuration: .default)
        let wsTask = session.webSocketTask(with: wsURL)
        workspaceWebSockets[workspace.id] = wsTask
        wsTask.resume()

        // Reload sessions now that agent-manager is confirmed running
        let ws = workspace
        Task { [weak self] in
            guard let self else { return }
            await self.loadSessions(for: ws, serverManager: serverManager, force: true)
        }

        let workspaceId = workspace.id
        let workspacePath = workspace.path

        workspaceWebSocketTasks[workspace.id] = Task { [weak self] in
            await self?.receiveWorkspaceEvents(wsTask: wsTask, workspaceId: workspaceId)

            // Connection ended — schedule reconnect
            guard let self else { return }
            self.workspaceWebSockets[workspaceId] = nil
            self.scheduleReconnect(
                workspaceId: workspaceId,
                workspacePath: workspacePath,
                serverManager: serverManager
            )
        }

        print("[WorkspaceVM] WebSocket connected for workspace \(workspace.id) at \(wsURL)")
    }

    private func receiveWorkspaceEvents(wsTask: URLSessionWebSocketTask, workspaceId: String) async {
        var didReceiveMessage = false
        while !Task.isCancelled {
            do {
                let message = try await wsTask.receive()

                // Reset backoff and restart counts after first successful message
                if !didReceiveMessage {
                    didReceiveMessage = true
                    reconnectAttempts[workspaceId] = 0
                    restartCounts[workspaceId] = 0
                }

                switch message {
                case .string(let text):
                    await handleWorkspaceEvent(text, workspaceId: workspaceId)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        await handleWorkspaceEvent(text, workspaceId: workspaceId)
                    }
                @unknown default:
                    break
                }
            } catch {
                if !Task.isCancelled {
                    print("[WorkspaceVM] WebSocket receive error for \(workspaceId): \(error)")
                }
                break
            }
        }
    }

    func disconnectWorkspaceEvents(for workspaceId: String) {
        reconnectTasks[workspaceId]?.cancel()
        reconnectTasks[workspaceId] = nil
        workspaceWebSocketTasks[workspaceId]?.cancel()
        workspaceWebSocketTasks[workspaceId] = nil
        workspaceWebSockets[workspaceId]?.cancel(with: .goingAway, reason: nil)
        workspaceWebSockets[workspaceId] = nil
        reconnectAttempts[workspaceId] = nil
        print("[WorkspaceVM] WebSocket disconnected for workspace \(workspaceId)")
    }

    func disconnectAllWorkspaceEvents() {
        for workspaceId in Array(workspaceWebSockets.keys) {
            disconnectWorkspaceEvents(for: workspaceId)
        }
    }

    private func scheduleReconnect(workspaceId: String, workspacePath: String, serverManager: ServerManager) {
        reconnectTasks[workspaceId]?.cancel()

        let attempts = reconnectAttempts[workspaceId] ?? 0

        // After 10 failed reconnect attempts, restart the agent-server (up to 2 times)
        if attempts >= 10 {
            let restarts = restartCounts[workspaceId] ?? 0
            if restarts >= 2 {
                print("[WorkspaceVM] Max reconnect attempts reached after \(restarts) restarts for \(workspaceId) — giving up")
                return
            }

            print("[WorkspaceVM] Max reconnect attempts (10) reached for \(workspaceId) — restarting agent-server (restart \(restarts + 1)/2)")
            reconnectAttempts[workspaceId] = 0
            restartCounts[workspaceId] = restarts + 1

            reconnectTasks[workspaceId] = Task { [weak self] in
                guard let self else { return }
                await serverManager.restartAgentManager(workspacePath: workspacePath)

                // Wait for the new server to be ready
                try? await Task.sleep(for: .seconds(2))

                guard let workspace = self.workspaces.first(where: { $0.id == workspaceId }) else { return }
                await self.connectWorkspaceEvents(for: workspace, serverManager: serverManager)
            }
            return
        }

        let delay = min(pow(2.0, Double(attempts)), 30.0)
        reconnectAttempts[workspaceId] = attempts + 1
        print("[WorkspaceVM] Scheduling reconnect for \(workspaceId) in \(delay)s (attempt \(attempts + 1))")

        reconnectTasks[workspaceId] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            guard let self = self,
                  let workspace = self.workspaces.first(where: { $0.id == workspaceId })
            else { return }
            await self.connectWorkspaceEvents(for: workspace, serverManager: serverManager)
        }
    }

    // MARK: - Workspace Event Handling

    private func handleWorkspaceEvent(_ text: String, workspaceId: String) async {
        guard let jsonData = text.data(using: .utf8),
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

            // Update session status for sidebar
            sessionStatuses[sessionID] = statusType

            // Update agent metadata in the agents list
            if var agents = agentsForWorkspace[workspaceId],
               let agentIndex = agents.firstIndex(where: { $0.sessionId == sessionID }) {
                agents[agentIndex].status = status
                agentsForWorkspace[workspaceId] = agents
            }
        }

        // Handle session.created for sub-agent tracking + sidebar session tree
        if eventType == "session.created",
           let infoDict = properties["info"] as? [String: Any],
           let sessionId = infoDict["id"] as? String,
           let title = infoDict["title"] as? String,
           let directory = infoDict["directory"] as? String,
           let timeDict = infoDict["time"] as? [String: Any],
           let created = timeDict["created"] as? Double,
           let updated = timeDict["updated"] as? Double {
            let parentID = infoDict["parentID"] as? String
            let newSession = SessionInfo(
                id: sessionId,
                directory: directory,
                parentID: parentID,
                title: title,
                time: SessionInfo.SessionTime(created: created, updated: updated)
            )
            // Add to the workspace's session list if not already present
            if var sessions = sessionsForWorkspace[workspaceId],
               !sessions.contains(where: { $0.id == sessionId }) {
                sessions.append(newSession)
                sessionsForWorkspace[workspaceId] = sessions
            }

            // Forward to sub-agent tracking handler
            if let parentID = parentID,
               let handler = sessionCreatedHandlers[parentID] {
                handler(SendableDict(value: json))
            }
        }

        // Route event to registered handler (ChatViewModel or SubAgentTracker)
        if let sessionID = sessionID,
           let handler = eventHandlers[sessionID] {
            handler(SendableDict(value: json))
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

    func registerEventHandler(sessionId: String, handler: @escaping @MainActor (SendableDict) -> Void) {
        eventHandlers[sessionId] = handler
    }

    func unregisterEventHandler(sessionId: String) {
        eventHandlers[sessionId] = nil
    }

    func registerSessionCreatedHandler(parentSessionId: String, handler: @escaping @MainActor @Sendable (SendableDict) -> Void) {
        sessionCreatedHandlers[parentSessionId] = handler
    }

    func unregisterSessionCreatedHandler(parentSessionId: String) {
        sessionCreatedHandlers[parentSessionId] = nil
    }

    /// Check if workspace events WebSocket is connected for a given workspace
    func isWorkspaceEventsConnected(for workspaceId: String) -> Bool {
        workspaceWebSockets[workspaceId] != nil
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

