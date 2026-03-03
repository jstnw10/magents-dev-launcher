import SwiftUI

struct GroupedContentView: View {
    let groupName: String
    let parts: [MessagePart]
    let isClosed: Bool
    var requestID: String?
    var onQuestionAnswer: ((String, [[String]]) -> Void)?

    @State private var isExpanded: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header row
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "rectangle.stack")
                        .font(.callout)
                        .foregroundStyle(Color.accentColor)
                    Text(groupName)
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

            // Grouped content
            if isExpanded {
                HStack(alignment: .top, spacing: 0) {
                    // Vertical line
                    Rectangle()
                        .fill(Color.accentColor.opacity(0.3))
                        .frame(width: 2)
                        .padding(.leading, 12)

                    // Content
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(parts) { part in
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
                        }
                    }
                    .padding(.leading, 10)
                    .padding(.trailing, 4)
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
                .padding(.bottom, 4)
            }
        }
        .background {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.accentColor.opacity(0.03))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.accentColor.opacity(0.08), lineWidth: 0.5)
        }

    }
}

