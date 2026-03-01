import SwiftUI

/// Simple placeholder for inline code block rendering.
/// Used for code snippets in chat messages; full code highlighting
/// is handled by the HTML/CSS in MarkdownRenderer for document views.
struct CodeBlockView: View {
    let code: String
    var language: String = ""

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .padding(12)
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

