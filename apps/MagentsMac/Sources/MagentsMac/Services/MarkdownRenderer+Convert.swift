import Foundation

// MARK: - Markdown-to-HTML Conversion

extension MarkdownRenderer {

    func convertMarkdown(_ markdown: String) -> String {
        let lines = markdown.components(separatedBy: "\n")
        var html: [String] = []
        var inCodeBlock = false
        var codeBlockLang = ""
        var codeBlockLines: [String] = []
        var inList = false
        var listType = ""
        var inTable = false
        var tableRows: [[String]] = []
        var i = 0

        while i < lines.count {
            let line = lines[i]

            // Code blocks
            if line.hasPrefix("```") {
                if inCodeBlock {
                    let code = escapeHTML(codeBlockLines.joined(separator: "\n"))
                    let langClass = codeBlockLang.isEmpty ? "" : " class=\"language-\(codeBlockLang)\""
                    html.append("<pre><code\(langClass)>\(code)</code></pre>")
                    codeBlockLines = []
                    codeBlockLang = ""
                    inCodeBlock = false
                } else {
                    closeList(&html, &inList, &listType)
                    inCodeBlock = true
                    codeBlockLang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                }
                i += 1; continue
            }
            if inCodeBlock { codeBlockLines.append(line); i += 1; continue }

            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Blank line
            if trimmed.isEmpty {
                closeList(&html, &inList, &listType)
                closeTable(&html, &inTable, &tableRows)
                i += 1; continue
            }

            // Horizontal rule
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                closeList(&html, &inList, &listType)
                html.append("<hr>")
                i += 1; continue
            }

            // Headings
            if let heading = parseHeading(line) {
                closeList(&html, &inList, &listType)
                html.append(heading)
                i += 1; continue
            }

            // Blockquote
            if line.hasPrefix("> ") || line == ">" {
                closeList(&html, &inList, &listType)
                let content = line.hasPrefix("> ") ? String(line.dropFirst(2)) : ""
                html.append("<blockquote><p>\(inlineMarkdown(content))</p></blockquote>")
                i += 1; continue
            }

            // Table
            if line.contains("|"), let cells = parseTableRow(line) {
                let isSep = cells.allSatisfy { $0.allSatisfy { "-:. ".contains($0) } }
                if !isSep {
                    if !inTable { inTable = true; tableRows = [] }
                    tableRows.append(cells)
                } else if !inTable {
                    inTable = true; tableRows = []
                }
                i += 1; continue
            } else if inTable {
                closeTable(&html, &inTable, &tableRows)
            }

            // Task list items
            if let taskItem = parseTaskItem(line) {
                if !inList || listType != "ul" {
                    closeList(&html, &inList, &listType)
                    html.append("<ul class=\"task-list\">"); inList = true; listType = "ul"
                }
                html.append(taskItem); i += 1; continue
            }

            // Unordered list
            if line.hasPrefix("- ") || line.hasPrefix("* ") {
                if !inList || listType != "ul" {
                    closeList(&html, &inList, &listType)
                    html.append("<ul>"); inList = true; listType = "ul"
                }
                html.append("<li>\(inlineMarkdown(String(line.dropFirst(2))))</li>")
                i += 1; continue
            }

            // Ordered list
            if let content = parseOrderedListItem(line) {
                if !inList || listType != "ol" {
                    closeList(&html, &inList, &listType)
                    html.append("<ol>"); inList = true; listType = "ol"
                }
                html.append("<li>\(inlineMarkdown(content))</li>")
                i += 1; continue
            }

            // Paragraph
            closeList(&html, &inList, &listType)
            html.append("<p>\(inlineMarkdown(line))</p>")
            i += 1
        }

        // Close any open blocks
        if inCodeBlock {
            let code = escapeHTML(codeBlockLines.joined(separator: "\n"))
            html.append("<pre><code>\(code)</code></pre>")
        }
        closeList(&html, &inList, &listType)
        closeTable(&html, &inTable, &tableRows)
        return html.joined(separator: "\n")
    }
}

