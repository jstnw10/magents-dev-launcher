import SwiftUI

/// Renders a markdown string with inline formatting and fenced code blocks.
/// Inline markdown (bold, italic, code, links, strikethrough) is rendered via
/// `AttributedString(markdown:)`. Fenced code blocks get a styled monospace view.
struct MarkdownTextView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .text(let content):
                    textView(for: content)
                case .codeBlock(let language, let code):
                    codeBlockView(language: language, code: code)
                }
            }
        }
        .textSelection(.enabled)
    }

    // MARK: - Text Rendering

    @ViewBuilder
    private func textView(for content: String) -> some View {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            EmptyView()
        } else if let attributed = try? AttributedString(
            markdown: trimmed,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(attributed)
                .font(.body)
        } else {
            Text(trimmed)
                .font(.body)
        }
    }

    // MARK: - Code Block Rendering

    @ViewBuilder
    private func codeBlockView(language: String, code: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header with language label and copy button
            if !language.isEmpty {
                HStack {
                    Text(language)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    copyButton(for: code)
                }
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .padding(.bottom, 4)
            } else {
                HStack {
                    Spacer()
                    copyButton(for: code)
                }
                .padding(.horizontal, 10)
                .padding(.top, 6)
            }

            // Code content
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 12, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 10)
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func copyButton(for code: String) -> some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(code, forType: .string)
        } label: {
            Image(systemName: "doc.on.doc")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .help("Copy code")
    }

    // MARK: - Parsing

    private enum Segment {
        case text(String)
        case codeBlock(language: String, code: String)
    }

    private var segments: [Segment] {
        parseSegments(from: text)
    }

    /// Splits the input into alternating text and fenced code block segments.
    private func parseSegments(from input: String) -> [Segment] {
        var result: [Segment] = []
        var remaining = input[...]

        while let fenceStart = remaining.range(of: "```") {
            // Text before the fence
            let textBefore = String(remaining[remaining.startIndex..<fenceStart.lowerBound])
            if !textBefore.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result.append(.text(textBefore))
            }

            // Extract language from the opening fence line
            let afterFence = remaining[fenceStart.upperBound...]
            let langEndIndex = afterFence.firstIndex(of: "\n") ?? afterFence.endIndex
            let language = String(afterFence[afterFence.startIndex..<langEndIndex])
                .trimmingCharacters(in: .whitespaces)

            let codeStart = langEndIndex < afterFence.endIndex
                ? afterFence.index(after: langEndIndex)
                : afterFence.endIndex

            // Find closing fence
            let searchRange = codeStart..<remaining.endIndex
            if let fenceEnd = remaining.range(of: "```", range: searchRange) {
                let code = String(remaining[codeStart..<fenceEnd.lowerBound])
                    .trimmingCharacters(in: CharacterSet.newlines)
                result.append(.codeBlock(language: language, code: code))
                remaining = remaining[fenceEnd.upperBound...]
            } else {
                // No closing fence – treat rest as code block
                let code = String(remaining[codeStart...])
                    .trimmingCharacters(in: CharacterSet.newlines)
                result.append(.codeBlock(language: language, code: code))
                remaining = remaining[remaining.endIndex...]
            }
        }

        // Remaining text after last code block
        let trailing = String(remaining)
        if !trailing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            result.append(.text(trailing))
        }

        // If no segments were found, treat entire input as text
        if result.isEmpty && !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            result.append(.text(input))
        }

        return result
    }
}

