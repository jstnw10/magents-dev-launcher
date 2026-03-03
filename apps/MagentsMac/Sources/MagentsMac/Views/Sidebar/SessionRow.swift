import SwiftUI

struct SessionRow: View {
    let session: SessionInfo
    let status: String?  // "idle", "busy", "retry", or nil
    let workspaceId: String?

    @Environment(TabManager.self) private var tabManager

    var body: some View {
        HStack(spacing: 8) {
            // Status indicator
            statusIndicator

            Image(systemName: session.parentID != nil ? "bubble.left" : "bubble.left.fill")
                .foregroundStyle(session.parentID != nil ? Color.secondary : Color.purple)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(cleanTitle(session.title))
                    .font(.body)
                    .lineLimit(1)

                if session.parentID != nil {
                    Text("sub-agent")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            tabManager.openTab(TabItem(
                title: cleanTitle(session.title),
                icon: "bubble.left.fill",
                contentType: .sessionChat(sessionId: session.id),
                workspaceId: workspaceId
            ))
        }
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch status {
        case "busy", "retry":
            ProgressView()
                .controlSize(.mini)
                .frame(width: 8)
        case "idle":
            Circle()
                .fill(.green)
                .frame(width: 8, height: 8)
        default:
            Circle()
                .fill(.secondary.opacity(0.3))
                .frame(width: 8, height: 8)
        }
    }

    /// Remove the (@general subagent) or (@explore subagent) suffix from titles
    private func cleanTitle(_ title: String) -> String {
        if let range = title.range(of: " (@", options: .backwards) {
            return String(title[title.startIndex..<range.lowerBound])
        }
        return title
    }
}

