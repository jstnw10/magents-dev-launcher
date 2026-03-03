import SwiftUI

struct MessageBubbleView: View {
    let message: ConversationMessage
    /// The request ID from the question.asked WebSocket frame.
    var requestID: String?
    /// Optional callback for answering interactive question tools.
    var onQuestionAnswer: ((String, [[String]]) -> Void)?

    // Regex patterns for group tags in text content
    private static let groupOpenPattern = try! NSRegularExpression(pattern: #"<group:([^>]+)>"#)
    private static let groupClosePattern = try! NSRegularExpression(pattern: #"</group(?::[^>]*)?>"#)

    /// Pre-processed display items computed from message parts, parsing
    /// `<group:Name>` / `</group>` tags from text content into collapsible sections.
    private var displayItems: [DisplayItem] {
        var items: [DisplayItem] = []
        let parts = message.parts

        // State for tracking an open group
        var currentGroupName: String? = nil
        var currentGroupParts: [MessagePart] = []

        for part in parts {
            // stepStart/stepFinish are OpenCode wrappers — skip them entirely
            if part.type == .stepStart || part.type == .stepFinish {
                continue
            }

            // Only text parts can contain group tags
            guard part.type == .text, let text = part.text else {
                // Non-text part: add to current group or as single
                if currentGroupName != nil {
                    currentGroupParts.append(part)
                } else {
                    items.append(.single(part: part))
                }
                continue
            }

            // Scan text for group open/close tags and split accordingly
            let nsText = text as NSString
            let fullRange = NSRange(location: 0, length: nsText.length)

            // Find all group open and close tags with their positions
            enum TagKind { case open(String), close }
            struct TagMatch {
                let kind: TagKind
                let range: NSRange
            }

            var tags: [TagMatch] = []
            for match in Self.groupOpenPattern.matches(in: text, range: fullRange) {
                let name = nsText.substring(with: match.range(at: 1))
                tags.append(TagMatch(kind: .open(name), range: match.range))
            }
            for match in Self.groupClosePattern.matches(in: text, range: fullRange) {
                tags.append(TagMatch(kind: .close, range: match.range))
            }
            tags.sort { $0.range.location < $1.range.location }

            if tags.isEmpty {
                // No tags in this text part — add whole part to group or as single
                if currentGroupName != nil {
                    currentGroupParts.append(part)
                } else {
                    items.append(.single(part: part))
                }
                continue
            }

            // Process text segments between tags
            var cursor = 0
            for tag in tags {
                let beforeEnd = tag.range.location
                // Text before this tag
                if beforeEnd > cursor {
                    let segment = nsText.substring(with: NSRange(location: cursor, length: beforeEnd - cursor))
                    let trimmed = segment.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty {
                        let segmentPart = MessagePart(
                            id: "\(part.id)-seg\(cursor)",
                            messageID: part.messageID,
                            type: .text,
                            text: segment
                        )
                        if currentGroupName != nil {
                            currentGroupParts.append(segmentPart)
                        } else {
                            items.append(.single(part: segmentPart))
                        }
                    }
                }

                switch tag.kind {
                case .open(let name):
                    // If there's already an open group, close it first (unclosed)
                    if let existingName = currentGroupName {
                        items.append(.group(name: existingName, parts: currentGroupParts, isClosed: false))
                        currentGroupParts = []
                    }
                    currentGroupName = name
                case .close:
                    if let groupName = currentGroupName {
                        items.append(.group(name: groupName, parts: currentGroupParts, isClosed: true))
                        currentGroupName = nil
                        currentGroupParts = []
                    }
                    // Orphan close tag without open — just skip
                }

                cursor = tag.range.location + tag.range.length
            }

            // Text after the last tag
            if cursor < nsText.length {
                let remaining = nsText.substring(from: cursor)
                let trimmed = remaining.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    let segmentPart = MessagePart(
                        id: "\(part.id)-seg\(cursor)",
                        messageID: part.messageID,
                        type: .text,
                        text: remaining
                    )
                    if currentGroupName != nil {
                        currentGroupParts.append(segmentPart)
                    } else {
                        items.append(.single(part: segmentPart))
                    }
                }
            }
        }

        // If a group is still open (streaming), emit it as unclosed
        if let groupName = currentGroupName {
            items.append(.group(name: groupName, parts: currentGroupParts, isClosed: false))
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
                    .font(.callout)
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
                        if isUser {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(Color.accentColor.opacity(0.15))
                        }
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
                                .padding(.bottom, 12)
                            }
                        }
                    }
                    .padding(10)
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
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                }

                // Relative timestamp
                Text(relativeTime(from: message.timestamp))
                    .font(.caption)
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

/// Represents either a single message part or a group of parts between `<group:Name>` / `</group>` tags.
private enum DisplayItem {
    case single(part: MessagePart)
    case group(name: String, parts: [MessagePart], isClosed: Bool)
}
