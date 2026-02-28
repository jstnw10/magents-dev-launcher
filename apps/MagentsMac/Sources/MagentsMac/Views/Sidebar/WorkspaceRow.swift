import SwiftUI

struct WorkspaceRow: View {
    let workspace: WorkspaceConfig

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: workspace.status == .active ? "folder.fill" : "folder")
                .foregroundStyle(workspace.status == .active ? .blue : .secondary)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(workspace.title)
                    .font(.body)
                    .lineLimit(1)

                Text(workspace.branch)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Circle()
                .fill(workspace.status == .active ? Color.green : Color.gray)
                .frame(width: 8, height: 8)
        }
        .contentShape(Rectangle())
    }
}

