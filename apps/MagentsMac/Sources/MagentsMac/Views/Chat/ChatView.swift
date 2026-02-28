import SwiftUI

struct ChatView: View {
    @State private var viewModel: ChatViewModel

    init(agentId: String, sessionId: String, workspacePath: String) {
        _viewModel = State(initialValue: ChatViewModel(
            agentId: agentId,
            sessionId: sessionId,
            workspacePath: workspacePath
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Messages area
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(viewModel.messages) { message in
                            MessageBubbleView(message: message)
                                .id(message.id)
                        }

                        if viewModel.isLoading {
                            StreamingIndicator()
                                .id("loading-indicator")
                        }
                    }
                    .padding(.vertical, 12)
                }
                .onChange(of: viewModel.messages.count) {
                    scrollToBottom(proxy: proxy)
                }
                .onChange(of: viewModel.isLoading) {
                    scrollToBottom(proxy: proxy)
                }
            }
            .overlay {
                if viewModel.messages.isEmpty && !viewModel.isLoading {
                    emptyState
                }
            }

            // Error banner
            if let error = viewModel.error {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.yellow)
                    Text(error)
                        .font(.caption)
                    Spacer()
                    Button("Dismiss") { viewModel.error = nil }
                        .buttonStyle(.plain)
                        .font(.caption)
                }
                .padding(8)
                .background(Color.red.opacity(0.1))
            }

            Divider()

            // Input area
            inputArea
        }
        .task {
            await viewModel.loadConversation()
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Send a message to start chatting")
                .font(.headline)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Input Area

    private var inputArea: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextEditor(text: $viewModel.inputText)
                .font(.body)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 36, maxHeight: 120)
                .fixedSize(horizontal: false, vertical: true)
                .padding(8)
                .background {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.secondary.opacity(0.08))
                }
                .onKeyPress(.return, phases: .down) { keyPress in
                    if keyPress.modifiers.contains(.shift) {
                        return .ignored // let shift+enter insert newline
                    }
                    Task { await viewModel.sendMessage() }
                    return .handled
                }

            Button {
                Task { await viewModel.sendMessage() }
            } label: {
                Image(systemName: "paperplane.fill")
                    .font(.title3)
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || viewModel.isLoading)
        }
        .padding(12)
    }

    // MARK: - Helpers

    private func scrollToBottom(proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) {
            if viewModel.isLoading {
                proxy.scrollTo("loading-indicator", anchor: .bottom)
            } else if let lastId = viewModel.messages.last?.id {
                proxy.scrollTo(lastId, anchor: .bottom)
            }
        }
    }
}

