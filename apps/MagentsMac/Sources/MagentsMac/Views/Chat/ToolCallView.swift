import SwiftUI

struct ToolCallView: View {
    let part: MessagePart
    /// The request ID from the question.asked WebSocket frame, needed for question replies.
    var requestID: String?
    /// Optional callback for answering interactive tools (e.g. question tool).
    var onQuestionAnswer: ((String, [[String]]) -> Void)?
    @State private var isExpanded = false

    var body: some View {
        // Interactive question tool
        if part.toolName == "question" && part.toolStatus == .running,
           let inputData = part.toolInputData,
           let rid = requestID,
           let onAnswer = onQuestionAnswer {
            QuestionToolView(inputData: inputData, requestID: rid, onSubmit: onAnswer)
        } else if part.toolName == "question" && part.toolStatus == .completed,
                  let inputData = part.toolInputData {
            CompletedQuestionView(inputData: inputData, toolOutput: part.toolOutput)
        } else {
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
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Text(toolDisplayName)
                        .font(.callout)
                        .fontWeight(.medium)
                    if let title = part.toolTitle, !title.isEmpty {
                        Text(title)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer()
                    if part.toolStatus == .completed || part.toolStatus == .error {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption)
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
        } // end else (non-question tool)
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
                .font(.callout)
                .foregroundStyle(.green)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .font(.callout)
                .foregroundStyle(.red)
        case .none:
            Image(systemName: "circle")
                .font(.callout)
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
        case "question": return "Question"
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
        case "question": return "questionmark.circle"
        default: return "wrench"
        }
    }

    // MARK: - Detail Section

    private func detailSection(label: String, content: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(content)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 200)
        }
    }
}



/// Read-only view for a completed question tool, showing the questions and options with answers.
struct CompletedQuestionView: View {
    let inputData: [String: Any]
    var toolOutput: String?

    private var questions: [[String: Any]] {
        inputData["questions"] as? [[String: Any]] ?? []
    }

    /// Parse `"question"="answer"` pairs from the tool output string.
    private var answeredPairs: [String: String] {
        guard let output = toolOutput else { return [:] }
        var pairs: [String: String] = [:]
        // Match patterns like "question text"="answer text"
        let pattern = #""([^"]+)"\s*=\s*"([^"]+)""#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [:] }
        let range = NSRange(output.startIndex..., in: output)
        let matches = regex.matches(in: output, range: range)
        for match in matches {
            if let qRange = Range(match.range(at: 1), in: output),
               let aRange = Range(match.range(at: 2), in: output) {
                pairs[String(output[qRange])] = String(output[aRange])
            }
        }
        return pairs
    }

    /// Find the answer for a question by matching against question text or header.
    private func answer(for question: [String: Any]) -> String? {
        let pairs = answeredPairs
        if let text = question["question"] as? String, let ans = pairs[text] {
            return ans
        }
        if let header = question["header"] as? String, let ans = pairs[header] {
            return ans
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.callout)
                    .foregroundStyle(.green)
                Image(systemName: "questionmark.circle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text("Question")
                    .font(.callout)
                    .fontWeight(.medium)
                Text("answered")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)

            ForEach(Array(questions.enumerated()), id: \.offset) { _, question in
                questionRow(question)
            }
        }
        .padding(.bottom, 6)
        .background {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.secondary.opacity(0.06))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.secondary.opacity(0.12), lineWidth: 0.5)
        }
    }

    @ViewBuilder
    private func questionRow(_ question: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let header = question["header"] as? String, !header.isEmpty {
                Text(header)
                    .font(.callout)
                    .fontWeight(.semibold)
                    .foregroundStyle(.secondary)
            }
            if let text = question["question"] as? String, !text.isEmpty {
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let ans = answer(for: question) {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark")
                        .font(.caption)
                        .foregroundStyle(Color.accentColor)
                    Text(ans)
                        .font(.callout)
                        .fontWeight(.medium)
                        .foregroundStyle(Color.accentColor)
                }
            }
        }
        .padding(.horizontal, 12)
    }
}
