import SwiftUI

struct ChatView: View {
    @Environment(ServerManager.self) private var serverManager
    @Environment(ChatViewModelStore.self) private var store

    let agentId: String
    let sessionId: String
    let workspacePath: String
    var workspaceId: String?

    private var viewModel: ChatViewModel {
        store.viewModel(agentId: agentId, sessionId: sessionId, workspacePath: workspacePath)
    }

    var body: some View {
        VStack(spacing: 0) {
            // Messages area
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(viewModel.messages) { message in
                            MessageBubbleView(message: message, requestID: viewModel.pendingQuestionRequestID, onQuestionAnswer: { requestID, answers in
                                Task { await viewModel.submitQuestionAnswer(answers: answers, requestID: requestID, serverManager: serverManager) }
                            })
                                .id(message.id)
                        }

                        // Show streaming response in real-time
                        if !viewModel.streamingPartOrder.isEmpty {
                            let streamingParts = viewModel.streamingPartOrder.compactMap { viewModel.streamingParts[$0] }
                            MessageBubbleView(
                                message: ConversationMessage(
                                    id: "streaming",
                                    role: .assistant,
                                    content: viewModel.streamingText,
                                    parts: streamingParts,
                                    timestamp: ISO8601DateFormatter().string(from: Date()),
                                    tokens: nil,
                                    cost: nil
                                ),
                                requestID: viewModel.pendingQuestionRequestID,
                                onQuestionAnswer: { requestID, answers in
                                    Task { await viewModel.submitQuestionAnswer(answers: answers, requestID: requestID, serverManager: serverManager) }
                                }
                            )
                            .id("streaming-message")
                        }

                        if viewModel.isLoading && viewModel.streamingPartOrder.isEmpty {
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
                .onChange(of: viewModel.streamingText) {
                    scrollToBottom(proxy: proxy)
                }
                .onChange(of: viewModel.streamingPartOrder.count) {
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
                        .font(.callout)
                    Spacer()
                    Button("Dismiss") { viewModel.error = nil }
                        .buttonStyle(.plain)
                        .font(.callout)
                }
                .padding(8)
                .background(Color.red.opacity(0.1))
            }

            // Sub-agent status bar
            if !viewModel.subAgentTracker.activeSubAgents.isEmpty {
                Divider()
                SubAgentStatusBar(
                    subAgents: viewModel.subAgentTracker.activeSubAgents,
                    workspaceId: workspaceId
                )
            }

            Divider()

            // Input area
            inputArea
        }
        .task {
            await viewModel.loadConversation(serverManager: serverManager)
            await viewModel.connectWebSocket(serverManager: serverManager)
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

    @ViewBuilder
    private var inputArea: some View {
        @Bindable var vm = viewModel
        HStack(alignment: .bottom, spacing: 8) {
            TextEditor(text: $vm.inputText)
                .font(.system(size: 15))
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
                    Task { await viewModel.sendMessage(serverManager: serverManager) }
                    return .handled
                }

            Button {
                Task { await viewModel.sendMessage(serverManager: serverManager) }
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
            if !viewModel.streamingPartOrder.isEmpty {
                proxy.scrollTo("streaming-message", anchor: .bottom)
            } else if viewModel.isLoading {
                proxy.scrollTo("loading-indicator", anchor: .bottom)
            } else if let lastId = viewModel.messages.last?.id {
                proxy.scrollTo(lastId, anchor: .bottom)
            }
        }
    }
}

