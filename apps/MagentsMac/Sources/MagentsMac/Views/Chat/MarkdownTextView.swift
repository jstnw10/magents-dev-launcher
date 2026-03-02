import SwiftUI

/// Renders a markdown string with inline formatting and fenced code blocks.
/// Inline markdown (bold, italic, code, links, strikethrough) is rendered via
/// `AttributedString(markdown:)`. Fenced code blocks get a styled monospace view.
/// Block-level elements (headings, lists, quotes, tables, rules) are also supported.
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
                case .heading(let level, let content):
                    headingView(level: level, text: content)
                case .horizontalRule:
                    horizontalRuleView()
                case .listItem(let indent, let ordered, let number, let content):
                    listItemView(indent: indent, ordered: ordered, number: number, text: content)
                case .blockQuote(let content):
                    blockQuoteView(text: content)
                case .table(let headers, let rows):
                    tableView(headers: headers, rows: rows)
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

    // MARK: - Heading Rendering

    @ViewBuilder
    private func headingView(level: Int, text content: String) -> some View {
        let font: Font = switch level {
        case 1: .title
        case 2: .title2
        case 3: .title3
        default: .headline
        }
        inlineMarkdownText(content)
            .font(font)
            .fontWeight(.bold)
    }

    // MARK: - Horizontal Rule Rendering

    private func horizontalRuleView() -> some View {
        Divider()
            .padding(.vertical, 4)
    }

    // MARK: - List Item Rendering

    @ViewBuilder
    private func listItemView(indent: Int, ordered: Bool, number: Int?, text content: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if ordered, let number {
                Text("\(number).")
                    .font(.body)
                    .foregroundStyle(.secondary)
            } else {
                Text("•")
                    .font(.body)
                    .foregroundStyle(.secondary)
            }
            inlineMarkdownText(content)
                .font(.body)
        }
        .padding(.leading, CGFloat(indent) * 16)
    }

    // MARK: - Block Quote Rendering

    @ViewBuilder
    private func blockQuoteView(text content: String) -> some View {
        HStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 1)
                .fill(Color.secondary.opacity(0.4))
                .frame(width: 3)
            inlineMarkdownText(content)
                .font(.body)
                .foregroundStyle(.secondary)
                .padding(.leading, 10)
        }
        .padding(.vertical, 2)
    }

    // MARK: - Table Rendering

    @ViewBuilder
    private func tableView(headers: [String], rows: [[String]]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header row
            HStack(spacing: 0) {
                ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
                    inlineMarkdownText(header)
                        .font(.body)
                        .fontWeight(.bold)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                }
            }
            Divider()
            // Data rows
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 0) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                        inlineMarkdownText(cell)
                            .font(.body)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                    }
                }
            }
        }
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.3))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    // MARK: - Inline Markdown Helper

    @ViewBuilder
    private func inlineMarkdownText(_ content: String) -> some View {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if let attributed = try? AttributedString(
            markdown: trimmed,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(attributed)
        } else {
            Text(trimmed)
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
        case heading(level: Int, text: String)
        case horizontalRule
        case listItem(indent: Int, ordered: Bool, number: Int?, text: String)
        case blockQuote(text: String)
        case table(headers: [String], rows: [[String]])
    }

    private var segments: [Segment] {
        let firstPass = parseCodeBlocks(from: text)
        return firstPass.flatMap { segment -> [Segment] in
            if case .text(let content) = segment {
                return parseBlockElements(from: content)
            }
            return [segment]
        }
    }

    /// First pass: splits the input into alternating text and fenced code block segments.
    private func parseCodeBlocks(from input: String) -> [Segment] {
        var result: [Segment] = []
        var remaining = input[...]

        while let fenceStart = remaining.range(of: "```") {
            let textBefore = String(remaining[remaining.startIndex..<fenceStart.lowerBound])
            if !textBefore.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result.append(.text(textBefore))
            }

            let afterFence = remaining[fenceStart.upperBound...]
            let langEndIndex = afterFence.firstIndex(of: "\n") ?? afterFence.endIndex
            let language = String(afterFence[afterFence.startIndex..<langEndIndex])
                .trimmingCharacters(in: .whitespaces)

            let codeStart = langEndIndex < afterFence.endIndex
                ? afterFence.index(after: langEndIndex)
                : afterFence.endIndex

            let searchRange = codeStart..<remaining.endIndex
            if let fenceEnd = remaining.range(of: "```", range: searchRange) {
                let code = String(remaining[codeStart..<fenceEnd.lowerBound])
                    .trimmingCharacters(in: CharacterSet.newlines)
                result.append(.codeBlock(language: language, code: code))
                remaining = remaining[fenceEnd.upperBound...]
            } else {
                let code = String(remaining[codeStart...])
                    .trimmingCharacters(in: CharacterSet.newlines)
                result.append(.codeBlock(language: language, code: code))
                remaining = remaining[remaining.endIndex...]
            }
        }

        let trailing = String(remaining)
        if !trailing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            result.append(.text(trailing))
        }

        if result.isEmpty && !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            result.append(.text(input))
        }

        return result
    }

    /// Second pass: splits a text segment into block-level elements.
    private func parseBlockElements(from content: String) -> [Segment] {
        let lines = content.components(separatedBy: "\n")
        var result: [Segment] = []
        var plainLines: [String] = []

        func flushPlainLines() {
            let joined = plainLines.joined(separator: "\n")
            if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                result.append(.text(joined))
            }
            plainLines.removeAll()
        }

        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Horizontal rule: ---, ***, ___
            if isHorizontalRule(trimmed) {
                flushPlainLines()
                result.append(.horizontalRule)
                i += 1
                continue
            }

            // Table: lines starting with |
            if trimmed.hasPrefix("|"), trimmed.hasSuffix("|") {
                // Collect consecutive table lines
                var tableLines: [String] = []
                while i < lines.count {
                    let tl = lines[i].trimmingCharacters(in: .whitespaces)
                    if tl.hasPrefix("|"), tl.hasSuffix("|") {
                        tableLines.append(tl)
                        i += 1
                    } else {
                        break
                    }
                }
                if let tableSegment = parseTable(from: tableLines) {
                    flushPlainLines()
                    result.append(tableSegment)
                } else {
                    plainLines.append(contentsOf: tableLines)
                }
                continue
            }

            // Heading: # through ######
            if let headingSegment = parseHeading(trimmed) {
                flushPlainLines()
                result.append(headingSegment)
                i += 1
                continue
            }

            // Block quote: > text
            if trimmed.hasPrefix("> ") || trimmed == ">" {
                flushPlainLines()
                let quoteText = trimmed.hasPrefix("> ")
                    ? String(trimmed.dropFirst(2))
                    : ""
                result.append(.blockQuote(text: quoteText))
                i += 1
                continue
            }

            // Unordered list: - item or * item (with optional leading spaces)
            if let listSegment = parseUnorderedListItem(line) {
                flushPlainLines()
                result.append(listSegment)
                i += 1
                continue
            }

            // Ordered list: 1. item (with optional leading spaces)
            if let listSegment = parseOrderedListItem(line) {
                flushPlainLines()
                result.append(listSegment)
                i += 1
                continue
            }

            // Plain text line
            plainLines.append(line)
            i += 1
        }

        flushPlainLines()
        return result
    }

    // MARK: - Block Element Helpers

    private func isHorizontalRule(_ line: String) -> Bool {
        let stripped = line.replacingOccurrences(of: " ", with: "")
        guard stripped.count >= 3 else { return false }
        let allSame = stripped.allSatisfy { $0 == "-" }
            || stripped.allSatisfy { $0 == "*" }
            || stripped.allSatisfy { $0 == "_" }
        return allSame
    }

    private func parseHeading(_ line: String) -> Segment? {
        var level = 0
        for ch in line {
            if ch == "#" { level += 1 } else { break }
        }
        guard level >= 1, level <= 6 else { return nil }
        guard line.count > level else { return .heading(level: level, text: "") }
        let afterHashes = line[line.index(line.startIndex, offsetBy: level)...]
        guard afterHashes.hasPrefix(" ") else { return nil }
        let text = String(afterHashes.dropFirst()).trimmingCharacters(in: .whitespaces)
        return .heading(level: level, text: text)
    }

    private func parseUnorderedListItem(_ line: String) -> Segment? {
        // Count leading spaces for indent level
        let leadingSpaces = line.prefix(while: { $0 == " " }).count
        let afterSpaces = line.dropFirst(leadingSpaces)
        guard afterSpaces.hasPrefix("- ") || afterSpaces.hasPrefix("* ") else { return nil }
        let text = String(afterSpaces.dropFirst(2))
        let indent = leadingSpaces / 2
        return .listItem(indent: indent, ordered: false, number: nil, text: text)
    }

    private func parseOrderedListItem(_ line: String) -> Segment? {
        let leadingSpaces = line.prefix(while: { $0 == " " }).count
        let afterSpaces = String(line.dropFirst(leadingSpaces))
        // Match digits followed by ". "
        var digits = ""
        for ch in afterSpaces {
            if ch.isNumber { digits.append(ch) } else { break }
        }
        guard !digits.isEmpty else { return nil }
        let rest = afterSpaces.dropFirst(digits.count)
        guard rest.hasPrefix(". ") else { return nil }
        let text = String(rest.dropFirst(2))
        let indent = leadingSpaces / 2
        return .listItem(indent: indent, ordered: true, number: Int(digits), text: text)
    }

    private func parseTable(from lines: [String]) -> Segment? {
        guard lines.count >= 2 else { return nil }

        func splitRow(_ line: String) -> [String] {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            // Remove leading and trailing |
            let inner: String
            if trimmed.hasPrefix("|") && trimmed.hasSuffix("|") {
                inner = String(trimmed.dropFirst().dropLast())
            } else {
                inner = trimmed
            }
            return inner.components(separatedBy: "|").map {
                $0.trimmingCharacters(in: .whitespaces)
            }
        }

        // Check if second line is a separator row (|---|---|)
        let separatorLine = lines[1].trimmingCharacters(in: .whitespaces)
        let sepInner: String
        if separatorLine.hasPrefix("|") && separatorLine.hasSuffix("|") {
            sepInner = String(separatorLine.dropFirst().dropLast())
        } else {
            sepInner = separatorLine
        }
        let isSeparator = sepInner.components(separatedBy: "|").allSatisfy { cell in
            let stripped = cell.trimmingCharacters(in: .whitespaces)
                .replacingOccurrences(of: "-", with: "")
                .replacingOccurrences(of: ":", with: "")
            return stripped.isEmpty
        }

        guard isSeparator else { return nil }

        let headers = splitRow(lines[0])
        let rows = lines.dropFirst(2).map { splitRow($0) }
        return .table(headers: headers, rows: rows)
    }
}

