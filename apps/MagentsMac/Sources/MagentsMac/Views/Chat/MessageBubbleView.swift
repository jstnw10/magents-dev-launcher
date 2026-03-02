import SwiftUI

struct MessageBubbleView: View {
    let message: ConversationMessage
    /// The request ID from the question.asked WebSocket frame.
    var requestID: String?
    /// Optional callback for answering interactive question tools.
    var onQuestionAnswer: ((String, [[String]]) -> Void)?

    /// Pre-processed display items computed from message parts, grouping content
    /// between stepStart/stepFinish into collapsible sections.
    private var displayItems: [DisplayItem] {
        var items: [DisplayItem] = []
        var i = 0
        let parts = message.parts

        while i < parts.count {
            let part = parts[i]
            if part.type == .stepStart {
                let groupName = part.text ?? "Group"
                var groupParts: [MessagePart] = []
                var isClosed = false
                i += 1
                while i < parts.count {
                    if parts[i].type == .stepFinish {
                        isClosed = true
                        i += 1
                        break
                    }
                    if parts[i].type == .stepStart {
                        // Nested group start — don't consume, let outer loop handle
                        break
                    }
                    groupParts.append(parts[i])
                    i += 1
                }
                items.append(.group(name: groupName, parts: groupParts, isClosed: isClosed))
            } else if part.type == .stepFinish {
                // Orphan stepFinish — skip
                i += 1
            } else {
                items.append(.single(part: part))
                i += 1
            }
        }
        return items
    }

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
                if isUser || message.parts.isEmpty {
                    // User messages or messages without parts
                    Group {
                        if isUser {
                            Text(message.content)
                                .textSelection(.enabled)
                        } else {
                            MarkdownTextView(text: message.content)
                        }
                    }
                    .padding(10)
                    .background {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(isUser ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.1))
                    }
                } else {
                    // Assistant messages with parts: render each part or group
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(displayItems.enumerated()), id: \.offset) { _, item in
                            switch item {
                            case .single(let part):
                                switch part.type {
                                case .text:
                                    if let text = part.text, !text.isEmpty {
                                        MarkdownTextView(text: text)
                                    }
                                case .reasoning:
                                    ReasoningView(part: part)
                                case .tool:
                                    ToolCallView(part: part, requestID: requestID, onQuestionAnswer: onQuestionAnswer)
                                case .stepStart, .stepFinish:
                                    EmptyView()
                                }
                            case .group(let name, let parts, let isClosed):
                                GroupedContentView(
                                    groupName: name,
                                    parts: parts,
                                    isClosed: isClosed,
                                    requestID: requestID,
                                    onQuestionAnswer: onQuestionAnswer
                                )
                            }
                        }
                    }
                    .padding(10)
                    .background {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color.secondary.opacity(0.1))
                    }
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


// MARK: - Display Item

/// Represents either a single message part or a group of parts between stepStart/stepFinish.
private enum DisplayItem {
    case single(part: MessagePart)
    case group(name: String, parts: [MessagePart], isClosed: Bool)
}
