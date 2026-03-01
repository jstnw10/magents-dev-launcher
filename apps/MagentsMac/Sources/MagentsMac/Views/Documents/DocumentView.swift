import SwiftUI
import WebKit

// MARK: - WebView Wrapper

/// Wraps a WKWebView for rendering HTML content in SwiftUI.
struct WebViewWrapper: NSViewRepresentable {
    let htmlContent: String

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        webView.loadHTMLString(htmlContent, baseURL: nil)
    }
}

// MARK: - Document View

/// Displays a rendered note/spec document with title bar and HTML content.
struct DocumentView: View {
    let noteId: String
    let workspacePath: String
    var isSpec: Bool = false

    @State private var viewModel = DocumentViewModel()

    var body: some View {
        VStack(spacing: 0) {
            // Title bar
            if let note = viewModel.note {
                documentHeader(note: note)
            }

            // Content
            if viewModel.isLoading {
                DocumentScanAnimation()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = viewModel.error {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 32))
                        .foregroundStyle(.secondary)
                    Text(error)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                Spacer()
            } else {
                WebViewWrapper(htmlContent: viewModel.htmlContent)
            }
        }
        .task {
            if isSpec {
                await viewModel.loadSpec(workspacePath: workspacePath)
            } else {
                await viewModel.loadNote(workspacePath: workspacePath, noteId: noteId)
            }
        }
    }

    @ViewBuilder
    private func documentHeader(note: Note) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: isSpec ? "doc.text.fill" : "note.text")
                    .foregroundStyle(.secondary)
                Text(note.title)
                    .font(.headline)
                Spacer()
            }

            if !note.tags.isEmpty {
                HStack(spacing: 6) {
                    ForEach(note.tags, id: \.self) { tag in
                        Text(tag)
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(.quaternary)
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        Divider()
    }
}

