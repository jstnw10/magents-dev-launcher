import SwiftUI

struct MessageBubbleView: View {
    let message: ConversationMessage

    var body: some View {
        let isUser = message.role == .user

        HStack {
            if isUser { Spacer(minLength: 60) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
                // Role label
                Text(isUser ? "You" : "Assistant")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                // Bubble
                Text(message.content)
                    .textSelection(.enabled)
                    .padding(10)
                    .background {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(isUser ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.1))
                    }

                // Metadata row
                if message.tokens != nil || message.cost != nil {
                    HStack(spacing: 8) {
                        if let tokens = message.tokens {
                            Text("↑\(tokens.input) ↓\(tokens.output) tokens")
                        }
                        if let cost = message.cost {
                            Text(String(format: "$%.2f", cost))
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                }

                // Relative timestamp
                Text(relativeTime(from: message.timestamp))
                    .font(.caption2)
                    .foregroundStyle(.quaternary)
            }

            if !isUser { Spacer(minLength: 60) }
        }
        .padding(.horizontal)
        .padding(.vertical, 2)
    }

    // MARK: - Helpers

    private func relativeTime(from isoString: String) -> String {
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: isoString) else { return "" }

        let interval = Date().timeIntervalSince(date)
        if interval < 60 { return "just now" }
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        if interval < 86400 { return "\(Int(interval / 3600))h ago" }
        return "\(Int(interval / 86400))d ago"
    }
}

