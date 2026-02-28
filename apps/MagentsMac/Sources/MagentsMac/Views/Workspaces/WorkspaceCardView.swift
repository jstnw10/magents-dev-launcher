import SwiftUI

struct WorkspaceCardView: View {
    let workspace: WorkspaceConfig
    var agentCount: Int = 0
    var noteCount: Int = 0

    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Top: Status dot + title + branch badge
            HStack(spacing: 8) {
                Circle()
                    .fill(workspace.status == .active ? Color.green : Color.gray)
                    .frame(width: 8, height: 8)

                Text(workspace.title)
                    .font(.headline)
                    .lineLimit(1)

                Spacer()

                Text(workspace.branch)
                    .font(.caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary)
                    .clipShape(Capsule())
                    .lineLimit(1)
            }

            // Middle: Repository name + creation date
            VStack(alignment: .leading, spacing: 4) {
                if let repoName = workspace.repositoryName {
                    HStack(spacing: 4) {
                        Image(systemName: "folder.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(repoName)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Text(formattedDate(workspace.createdAt))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            // Bottom: Agent and note counts
            HStack(spacing: 16) {
                HStack(spacing: 4) {
                    Image(systemName: "person.2")
                        .font(.caption2)
                    Text("\(agentCount)")
                        .font(.caption)
                }
                .foregroundStyle(.secondary)

                HStack(spacing: 4) {
                    Image(systemName: "doc.text")
                        .font(.caption2)
                    Text("\(noteCount)")
                        .font(.caption)
                }
                .foregroundStyle(.secondary)

                Spacer()

                // Status badge
                Text(workspace.status == .active ? "Active" : "Archived")
                    .font(.caption2)
                    .fontWeight(.medium)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(workspace.status == .active ? Color.green.opacity(0.15) : Color.gray.opacity(0.15))
                    .foregroundStyle(workspace.status == .active ? .green : .gray)
                    .clipShape(Capsule())
            }
        }
        .padding(14)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(.quaternary, lineWidth: 1)
        )
        .scaleEffect(isHovered ? 1.02 : 1.0)
        .animation(.easeInOut(duration: 0.15), value: isHovered)
        .onHover { hovering in
            isHovered = hovering
        }
        .contentShape(Rectangle())
    }

    private func formattedDate(_ isoString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: isoString) else {
            // Try without fractional seconds
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: isoString) else {
                return isoString
            }
            return date.formatted(date: .abbreviated, time: .omitted)
        }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

