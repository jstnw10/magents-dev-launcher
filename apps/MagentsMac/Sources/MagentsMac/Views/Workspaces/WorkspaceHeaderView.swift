import SwiftUI

struct WorkspaceHeaderView: View {
    let workspace: WorkspaceConfig
    var onArchiveToggle: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            // Title
            Text(workspace.title)
                .font(.headline)
                .lineLimit(1)

            // Branch badge
            HStack(spacing: 4) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.caption2)
                Text(workspace.branch)
                    .font(.caption)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.quaternary)
            .clipShape(Capsule())

            // Repository name
            if let repoName = workspace.repositoryName {
                Text(repoName)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            // Status badge
            Text(workspace.status == .active ? "Active" : "Archived")
                .font(.caption2)
                .fontWeight(.medium)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(workspace.status == .active ? Color.green.opacity(0.15) : Color.gray.opacity(0.15))
                .foregroundStyle(workspace.status == .active ? .green : .gray)
                .clipShape(Capsule())

            Spacer()

            // Archive / Unarchive button
            Button {
                onArchiveToggle?()
            } label: {
                Label(
                    workspace.status == .active ? "Archive" : "Unarchive",
                    systemImage: workspace.status == .active ? "archivebox" : "archivebox.fill"
                )
                .font(.caption)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(height: 40)
        .background(.regularMaterial)
    }
}

