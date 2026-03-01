import SwiftUI

struct AgentRow: View {
    let agent: AgentMetadata
    let workspacePath: String
    var onRemove: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            // Status indicator
            statusIndicator

            Image(systemName: "bubble.left.fill")
                .foregroundStyle(.purple)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(agent.label)
                    .font(.body)
                    .lineLimit(1)

                if let specialist = agent.specialistId {
                    Text(specialist)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .contentShape(Rectangle())
        .contextMenu {
            Button("Copy Agent ID") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(agent.agentId, forType: .string)
            }

            Divider()

            Button("Remove Agent", role: .destructive) {
                Task {
                    await removeAgent()
                }
            }
        }
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch agent.status {
        case .busy, .retry:
            ProgressView()
                .controlSize(.mini)
                .frame(width: 8)
        case .idle:
            Circle()
                .fill(.green)
                .frame(width: 8, height: 8)
        case .none:
            Circle()
                .fill(.secondary.opacity(0.3))
                .frame(width: 8, height: 8)
        }
    }

    private func removeAgent() async {
        // Delete metadata file
        let filePath = "\(workspacePath)/.workspace/opencode/agents/\(agent.agentId).json"
        try? FileManager.default.removeItem(atPath: filePath)

        // Try to delete the OpenCode session
        let fileManager = WorkspaceFileManager()
        if let serverInfo = try? await fileManager.readServerInfo(workspacePath: workspacePath) {
            let client = OpenCodeClient(serverInfo: serverInfo)
            try? await client.deleteSession(id: agent.sessionId)
        }

        onRemove?()
    }
}

