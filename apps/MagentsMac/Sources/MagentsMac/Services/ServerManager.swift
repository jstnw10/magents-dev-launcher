import Foundation
import Observation

/// Tracks and controls the OpenCode server lifecycle per workspace.
@MainActor
@Observable
final class ServerManager {

    enum ServerStatus: Sendable {
        case unknown
        case running(ServerInfo)
        case stopped
    }

    var serverStatus: [String: ServerStatus] = [:]

    private let fileManager = WorkspaceFileManager()

    // MARK: - Status

    func status(for workspacePath: String) -> ServerStatus {
        serverStatus[workspacePath] ?? .unknown
    }

    func checkStatus(workspacePath: String) async {
        do {
            guard let info = try await fileManager.readServerInfo(workspacePath: workspacePath) else {
                serverStatus[workspacePath] = .stopped
                return
            }

            if isPIDAlive(info.pid) {
                serverStatus[workspacePath] = .running(info)
            } else {
                serverStatus[workspacePath] = .stopped
            }
        } catch {
            serverStatus[workspacePath] = .stopped
        }
    }

    // MARK: - Start / Stop

    func startServer(workspacePath: String) async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["magents", "agent", "server-start", "--workspace", workspacePath]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            throw ServerManagerError.startFailed(exitCode: process.terminationStatus)
        }

        // Re-check status after starting
        await checkStatus(workspacePath: workspacePath)
    }

    func stopServer(workspacePath: String) async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["magents", "agent", "server-stop", "--workspace", workspacePath]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            throw ServerManagerError.stopFailed(exitCode: process.terminationStatus)
        }

        serverStatus[workspacePath] = .stopped
    }

    // MARK: - Helpers

    private nonisolated func isPIDAlive(_ pid: Int) -> Bool {
        // kill with signal 0 checks if process exists without sending a signal
        kill(Int32(pid), 0) == 0
    }
}

enum ServerManagerError: Error, LocalizedError {
    case startFailed(exitCode: Int32)
    case stopFailed(exitCode: Int32)

    var errorDescription: String? {
        switch self {
        case .startFailed(let code):
            return "Failed to start server (exit code \(code))"
        case .stopFailed(let code):
            return "Failed to stop server (exit code \(code))"
        }
    }
}

