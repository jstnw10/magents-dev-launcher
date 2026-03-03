import SwiftUI

struct SubAgentStatusBar: View {
    @Environment(TabManager.self) private var tabManager

    let subAgents: [SubAgentInfo]
    let workspaceId: String?

    var body: some View {
        if !subAgents.isEmpty {
            VStack(spacing: 4) {
                ForEach(subAgents) { agent in
                    SubAgentCard(agent: agent, workspaceId: workspaceId)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .animation(.easeInOut(duration: 0.25), value: subAgents.map(\.id))
        }
    }
}

// MARK: - Sub-Agent Card

private struct SubAgentCard: View {
    @Environment(TabManager.self) private var tabManager

    let agent: SubAgentInfo
    let workspaceId: String?

    @State private var fadeOut = false

    var body: some View {
        Button {
            tabManager.openTab(TabItem(
                title: agent.label,
                icon: "bubble.left.fill",
                contentType: .sessionChat(sessionId: agent.sessionId),
                workspaceId: workspaceId
            ))
        } label: {
            HStack(spacing: 8) {
                // Status indicator
                if agent.isComplete {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .font(.system(size: 14))
                } else {
                    ProgressView()
                        .controlSize(.small)
                }

                // Label and streaming line
                VStack(alignment: .leading, spacing: 1) {
                    Text(agent.label)
                        .font(.callout.bold())
                        .lineLimit(1)

                    if !agent.lastStreamingLine.isEmpty {
                        Text(agent.lastStreamingLine)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }

                Spacer(minLength: 0)

                // Chevron
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxHeight: 50)
            .background {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.secondary.opacity(0.08))
            }
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .opacity(fadeOut ? 0 : 1)
        .onChange(of: agent.isComplete) { _, isComplete in
            if isComplete {
                withAnimation(.easeOut(duration: 0.5).delay(3.0)) {
                    fadeOut = true
                }
            }
        }
    }
}

