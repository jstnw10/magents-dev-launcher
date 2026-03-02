import SwiftUI

struct ReasoningView: View {
    let part: MessagePart
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "brain")
                        .font(.callout)
                        .foregroundStyle(.purple)
                    Text("Thinking…")
                        .font(.callout)
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)

            if isExpanded, let text = part.text, !text.isEmpty {
                Divider()
                    .padding(.horizontal, 8)
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(8)
            }
        }
        .background {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.purple.opacity(0.04))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.purple.opacity(0.1), lineWidth: 0.5)
        }
    }
}

