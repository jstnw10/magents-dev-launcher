import SwiftUI

/// Interactive view for the OpenCode `question` tool.
/// Renders questions with selectable option cards and a submit button.
struct QuestionToolView: View {
    let inputData: [String: Any]
    let requestID: String
    let onSubmit: (String, [[String]]) -> Void

    @State private var selections: [Int: Int] = [:]  // questionIndex → optionIndex

    private var questions: [[String: Any]] {
        inputData["questions"] as? [[String: Any]] ?? []
    }

    private var allAnswered: Bool {
        guard !questions.isEmpty else { return false }
        for (index, q) in questions.enumerated() {
            let options = q["options"] as? [[String: Any]] ?? []
            if !options.isEmpty && selections[index] == nil {
                return false
            }
        }
        return true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Tool header
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.mini)
                Image(systemName: "questionmark.circle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text("Question")
                    .font(.callout)
                    .fontWeight(.medium)
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.top, 6)

            ForEach(Array(questions.enumerated()), id: \.offset) { qIndex, question in
                questionCard(index: qIndex, question: question)
            }

            // Submit button
            if !questions.isEmpty {
                HStack {
                    Spacer()
                    Button {
                        onSubmit(requestID, formatAnswer())
                    } label: {
                        Text("Submit")
                            .font(.callout)
                            .fontWeight(.medium)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!allAnswered)
                    .padding(.bottom, 8)
                    .padding(.trailing, 8)
                }
            }
        }
        .background {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.secondary.opacity(0.06))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.accentColor.opacity(0.3), lineWidth: 1)
        }
    }

    // MARK: - Question Card

    @ViewBuilder
    private func questionCard(index: Int, question: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let header = question["header"] as? String, !header.isEmpty {
                Text(header)
                    .font(.callout)
                    .fontWeight(.semibold)
                    .foregroundStyle(.secondary)
            }
            if let text = question["question"] as? String, !text.isEmpty {
                Text(text)
                    .font(.body)
            }

            let options = question["options"] as? [[String: Any]] ?? []
            ForEach(Array(options.enumerated()), id: \.offset) { optIndex, option in
                optionButton(
                    questionIndex: index,
                    optionIndex: optIndex,
                    label: option["label"] as? String ?? "Option \(optIndex + 1)",
                    description: option["description"] as? String
                )
            }
        }
        .padding(.horizontal, 12)
    }

    @ViewBuilder
    private func optionButton(questionIndex: Int, optionIndex: Int, label: String, description: String?) -> some View {
        let isSelected = selections[questionIndex] == optionIndex
        Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                selections[questionIndex] = optionIndex
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? Color.accentColor : .secondary)
                    .font(.body)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(.body)
                        .fontWeight(isSelected ? .medium : .regular)
                    if let desc = description, !desc.isEmpty {
                        Text(desc)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer()
            }
            .padding(8)
            .background {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(isSelected ? Color.accentColor.opacity(0.1) : Color.clear)
            }
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(isSelected ? Color.accentColor.opacity(0.4) : Color.secondary.opacity(0.15), lineWidth: 0.5)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Format Answer

    private func formatAnswer() -> [[String]] {
        questions.enumerated().map { qIndex, question in
            guard let optIndex = selections[qIndex] else { return [] }
            let options = question["options"] as? [[String: Any]] ?? []
            guard optIndex < options.count else { return [] }
            let label = options[optIndex]["label"] as? String ?? "Option \(optIndex + 1)"
            return [label]
        }
    }
}

