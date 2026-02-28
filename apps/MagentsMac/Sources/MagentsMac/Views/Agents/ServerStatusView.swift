import SwiftUI

/// Compact server status indicator with start/stop controls.
struct ServerStatusView: View {
    let workspacePath: String

    @Environment(ServerManager.self) private var serverManager

    var body: some View {
        HStack(spacing: 8) {
            statusIndicator
            Spacer()
            actionButton
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .task {
            await serverManager.checkStatus(workspacePath: workspacePath)
        }
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch serverManager.status(for: workspacePath) {
        case .running(let info):
            Label("Port \(info.port)", systemImage: "circle.fill")
                .font(.caption)
                .foregroundStyle(.green)
        case .stopped:
            Label("Stopped", systemImage: "circle.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .unknown:
            Label("Checking…", systemImage: "circle.dashed")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch serverManager.status(for: workspacePath) {
        case .running:
            Button("Stop") {
                Task {
                    try? await serverManager.stopServer(workspacePath: workspacePath)
                }
            }
            .controlSize(.small)
            .buttonStyle(.bordered)
        case .stopped:
            Button("Start") {
                Task {
                    try? await serverManager.startServer(workspacePath: workspacePath)
                }
            }
            .controlSize(.small)
            .buttonStyle(.bordered)
        case .unknown:
            ProgressView()
                .controlSize(.small)
        }
    }
}

