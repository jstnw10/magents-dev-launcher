import SwiftUI

struct ToolCallView: View {
    let part: MessagePart
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header row: status icon + tool icon + display name + title
            Button {
                if part.toolStatus == .completed || part.toolStatus == .error {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isExpanded.toggle()
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    statusIcon
                    Image(systemName: toolIcon)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(toolDisplayName)
                        .font(.caption)
                        .fontWeight(.medium)
                    if let title = part.toolTitle, !title.isEmpty {
                        Text(title)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer()
                    if part.toolStatus == .completed || part.toolStatus == .error {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)

            // Expandable input/output
            if isExpanded {
                Divider()
                    .padding(.horizontal, 8)
                VStack(alignment: .leading, spacing: 8) {
                    if let input = part.toolInput, !input.isEmpty {
                        detailSection(label: "Input", content: input)
                    }
                    if let output = part.toolOutput, !output.isEmpty {
                        detailSection(label: "Output", content: output)
                    }
                }
                .padding(8)
            }
        }
        .background {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.secondary.opacity(0.06))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.secondary.opacity(0.12), lineWidth: 0.5)
        }
    }

    // MARK: - Status Icon

    @ViewBuilder
    private var statusIcon: some View {
        switch part.toolStatus {
        case .pending, .running:
            ProgressView()
                .controlSize(.mini)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.green)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.red)
        case .none:
            Image(systemName: "circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Tool Name Mapping

    private var toolDisplayName: String {
        guard let name = part.toolName else { return "Tool" }
        switch name {
        case "read": return "Read"
        case "list": return "List"
        case "glob": return "Glob"
        case "grep": return "Grep"
        case "webfetch": return "Web Fetch"
        case "task": return "Agent"
        case "bash": return "Shell"
        case "edit": return "Edit"
        case "write": return "Write"
        case "apply_patch": return "Patch"
        default: return name
        }
    }

    private var toolIcon: String {
        guard let name = part.toolName else { return "wrench" }
        switch name {
        case "bash": return "terminal"
        case "read", "write", "edit", "apply_patch": return "doc.text"
        case "grep", "glob": return "magnifyingglass"
        case "webfetch": return "globe"
        case "task": return "person.2"
        case "list": return "list.bullet"
        default: return "wrench"
        }
    }

    // MARK: - Detail Section

    private func detailSection(label: String, content: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(content)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 200)
        }
    }
}

