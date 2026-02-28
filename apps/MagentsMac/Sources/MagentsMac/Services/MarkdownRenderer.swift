import Foundation

/// Converts markdown text to a full HTML document with embedded CSS styling.
struct MarkdownRenderer: Sendable {

    /// Renders markdown string into a complete HTML document.
    func render(_ markdown: String) -> String {
        let body = convertMarkdown(markdown)
        return wrapInHTMLTemplate(body)
    }

    // MARK: - Inline Markdown

    func inlineMarkdown(_ text: String) -> String {
        var result = escapeHTML(text)
        result = replacePattern(result, pattern: "\\*\\*(.+?)\\*\\*", template: "<strong>$1</strong>")
        result = replacePattern(result, pattern: "__(.+?)__", template: "<strong>$1</strong>")
        result = replacePattern(result, pattern: "\\*(.+?)\\*", template: "<em>$1</em>")
        result = replacePattern(result, pattern: "`([^`]+)`", template: "<code>$1</code>")
        result = replacePattern(result, pattern: "\\[([^\\]]+)\\]\\(([^)]+)\\)", template: "<a href=\"$2\">$1</a>")
        result = replacePattern(result, pattern: "~~(.+?)~~", template: "<del>$1</del>")
        return result
    }

    private func replacePattern(_ text: String, pattern: String, template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: template)
    }

    func escapeHTML(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    // MARK: - Block Helpers

    func parseHeading(_ line: String) -> String? {
        for level in (1...6).reversed() {
            let prefix = String(repeating: "#", count: level) + " "
            if line.hasPrefix(prefix) {
                let content = String(line.dropFirst(prefix.count))
                return "<h\(level)>\(inlineMarkdown(content))</h\(level)>"
            }
        }
        return nil
    }

    func parseTaskItem(_ line: String) -> String? {
        if line.hasPrefix("- [ ] ") {
            return "<li class=\"task-item\"><input type=\"checkbox\" disabled> \(inlineMarkdown(String(line.dropFirst(6))))</li>"
        } else if line.hasPrefix("- [x] ") || line.hasPrefix("- [X] ") {
            return "<li class=\"task-item\"><input type=\"checkbox\" checked disabled> \(inlineMarkdown(String(line.dropFirst(6))))</li>"
        } else if line.hasPrefix("- [/] ") {
            return "<li class=\"task-item\"><span class=\"checkbox-partial\">◐</span> \(inlineMarkdown(String(line.dropFirst(6))))</li>"
        }
        return nil
    }

    func parseOrderedListItem(_ line: String) -> String? {
        guard let dotIndex = line.firstIndex(of: ".") else { return nil }
        let numPart = line[line.startIndex..<dotIndex]
        guard numPart.allSatisfy(\.isNumber), !numPart.isEmpty else { return nil }
        let afterDot = line.index(after: dotIndex)
        guard afterDot < line.endIndex, line[afterDot] == " " else { return nil }
        return String(line[line.index(after: afterDot)...])
    }

    func parseTableRow(_ line: String) -> [String]? {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.hasPrefix("|"), t.hasSuffix("|") else { return nil }
        let inner = String(t.dropFirst().dropLast())
        let cells = inner.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
        return cells.isEmpty ? nil : cells
    }

    func closeList(_ html: inout [String], _ inList: inout Bool, _ listType: inout String) {
        guard inList else { return }
        html.append("</\(listType)>")
        inList = false
        listType = ""
    }

    func closeTable(_ html: inout [String], _ inTable: inout Bool, _ tableRows: inout [[String]]) {
        guard inTable, !tableRows.isEmpty else { inTable = false; return }
        var t = "<table>"
        for (ri, cells) in tableRows.enumerated() {
            let tag = ri == 0 ? "th" : "td"
            if ri == 0 { t += "<thead>" }
            if ri == 1 { t += "<tbody>" }
            t += "<tr>"
            for cell in cells { t += "<\(tag)>\(inlineMarkdown(cell))</\(tag)>" }
            t += "</tr>"
            if ri == 0 { t += "</thead>" }
        }
        if tableRows.count > 1 { t += "</tbody>" }
        t += "</table>"
        html.append(t)
        inTable = false
        tableRows = []
    }
}

