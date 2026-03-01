import Foundation
import Observation
import os

/// Tracks and controls the OpenCode server lifecycle per workspace.
/// Spawns `opencode serve` natively instead of shelling out to the `magents` CLI.
@MainActor
@Observable
final class ServerManager {

    enum ServerStatus: Sendable {
        case unknown
        case starting
        case running(ServerInfo)
        case stopped
        case error(String)
    }

    var serverStatus: [String: ServerStatus] = [:]

    /// Keep references to running processes so they don't get deallocated.
    private var runningProcesses: [String: Process] = [:]
    private var nextPort: Int = 4096

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
                // Clean up stale server.json
                try? Foundation.FileManager.default.removeItem(
                    atPath: "\(workspacePath)/.workspace/opencode/server.json"
                )
            }
        } catch {
            serverStatus[workspacePath] = .stopped
        }
    }

    // MARK: - Get or Start

    /// Ensures a server is running for the workspace. Returns the ServerInfo.
    func getOrStart(workspacePath: String) async throws -> ServerInfo {
        // Check if already running in-memory
        if case .running(let info) = serverStatus[workspacePath] {
            if isPIDAlive(info.pid) {
                return info
            }
        }

        // Check server.json on disk
        if let info = try? await fileManager.readServerInfo(workspacePath: workspacePath),
           isPIDAlive(info.pid) {
            serverStatus[workspacePath] = .running(info)
            return info
        }

        // Need to start
        return try await startServer(workspacePath: workspacePath)
    }

    // MARK: - Start

    @discardableResult
    func startServer(workspacePath: String) async throws -> ServerInfo {
        serverStatus[workspacePath] = .starting

        // 1. Find opencode binary
        let opencodePath: String
        do {
            opencodePath = try await findOpencodeBinary()
        } catch {
            serverStatus[workspacePath] = .error(error.localizedDescription)
            throw error
        }

        // 2. Allocate port — skip ports already in use
        var port = nextPort
        nextPort += 1
        while !isPortAvailable(port) {
            port = nextPort
            nextPort += 1
        }

        // 3. Create data directory
        let dataDir = "\(workspacePath)/.workspace/opencode/data"
        let fm = Foundation.FileManager.default
        if !fm.fileExists(atPath: dataDir) {
            try fm.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
        }

        // 4. Spawn opencode serve
        let process = Process()
        process.executableURL = URL(fileURLWithPath: opencodePath)
        process.arguments = ["serve", "--hostname=127.0.0.1", "--port=\(port)"]
        process.currentDirectoryURL = URL(fileURLWithPath: workspacePath)

        var env = ProcessInfo.processInfo.environment
        env["OPENCODE_CONFIG_DIR"] = dataDir
        process.environment = env

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            serverStatus[workspacePath] = .error("Failed to launch opencode: \(error.localizedDescription)")
            throw error
        }

        // 5. Wait for "opencode server listening" in stdout
        let url = try await waitForServerReady(pipe: stdoutPipe, port: port, process: process)

        // 6. Build and persist server info
        let info = ServerInfo(
            pid: Int(process.processIdentifier),
            port: port,
            url: url,
            startedAt: ISO8601DateFormatter().string(from: Date())
        )

        let serverJsonPath = "\(workspacePath)/.workspace/opencode/server.json"
        let serverJsonDir = (serverJsonPath as NSString).deletingLastPathComponent
        if !fm.fileExists(atPath: serverJsonDir) {
            try fm.createDirectory(atPath: serverJsonDir, withIntermediateDirectories: true)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        let data = try encoder.encode(info)
        try data.write(to: URL(fileURLWithPath: serverJsonPath))

        // 7. Keep process alive
        runningProcesses[workspacePath] = process
        serverStatus[workspacePath] = .running(info)

        return info
    }

    // MARK: - Stop

    func stopServer(workspacePath: String) async throws {
        if let process = runningProcesses[workspacePath] {
            if process.isRunning {
                process.terminate()
            }
            runningProcesses.removeValue(forKey: workspacePath)
        } else {
            // Try to kill by PID from server.json
            if let info = try? await fileManager.readServerInfo(workspacePath: workspacePath) {
                if isPIDAlive(info.pid) {
                    kill(Int32(info.pid), SIGTERM)
                }
            }
        }

        // Remove server.json
        try? Foundation.FileManager.default.removeItem(
            atPath: "\(workspacePath)/.workspace/opencode/server.json"
        )
        serverStatus[workspacePath] = .stopped
    }

    /// Stop all running servers (call on app termination).
    func stopAll() {
        for (_, process) in runningProcesses {
            if process.isRunning {
                process.terminate()
            }
        }
        runningProcesses.removeAll()
    }

    // MARK: - Helpers

    private nonisolated func isPIDAlive(_ pid: Int) -> Bool {
        kill(Int32(pid), 0) == 0
    }

    private nonisolated func isPortAvailable(_ port: Int) -> Bool {
        let socketFD = socket(AF_INET, SOCK_STREAM, 0)
        guard socketFD >= 0 else { return false }
        defer { close(socketFD) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Darwin.connect(socketFD, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        // If connect succeeds, port is in use; if it fails, port is available
        return result != 0
    }

    private func findOpencodeBinary() async throws -> String {
        // 1. Check ~/.magents/config.json for opencodePath
        let home = Foundation.FileManager.default.homeDirectoryForCurrentUser.path
        let configPath = "\(home)/.magents/config.json"
        if Foundation.FileManager.default.fileExists(atPath: configPath),
           let data = try? Data(contentsOf: URL(fileURLWithPath: configPath)),
           let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let path = config["opencodePath"] as? String,
           Foundation.FileManager.default.fileExists(atPath: path) {
            return path
        }

        // 2. Fall back to `which opencode`
        let result = try await ShellRunner.run("which opencode")
        let path = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard result.exitCode == 0, !path.isEmpty else {
            throw ServerManagerError.opencodeNotFound
        }
        return path
    }

    /// Wait for "opencode server listening on http://..." in stdout.
    private func waitForServerReady(pipe: Pipe, port: Int, process: Process) async throws -> String {
        return try await withCheckedThrowingContinuation { continuation in
            let state = OSAllocatedUnfairLock(initialState: (resumed: false, accumulated: ""))
            let handle = pipe.fileHandleForReading

            // Timeout after 15 seconds — return expected URL anyway
            DispatchQueue.global().asyncAfter(deadline: .now() + 15) {
                let shouldResume = state.withLock { s -> Bool in
                    guard !s.resumed else { return false }
                    s.resumed = true
                    return true
                }
                if shouldResume {
                    continuation.resume(returning: "http://127.0.0.1:\(port)")
                }
            }

            // Read stdout in background
            DispatchQueue.global().async {
                while process.isRunning {
                    let data = handle.availableData
                    if data.isEmpty { break }
                    if let text = String(data: data, encoding: .utf8) {
                        let foundURL: String? = state.withLock { s -> String? in
                            s.accumulated += text
                            for line in s.accumulated.components(separatedBy: "\n") {
                                if line.contains("listening") || line.contains("server") {
                                    if let range = line.range(of: "http://[^\\s]+", options: .regularExpression) {
                                        let url = String(line[range])
                                        if !s.resumed {
                                            s.resumed = true
                                            return url
                                        }
                                    }
                                }
                            }
                            return nil
                        }
                        if let url = foundURL {
                            continuation.resume(returning: url)
                            return
                        }
                    }
                }
                // Process ended without ready message
                let shouldResume = state.withLock { s -> Bool in
                    guard !s.resumed else { return false }
                    s.resumed = true
                    return true
                }
                if shouldResume {
                    continuation.resume(returning: "http://127.0.0.1:\(port)")
                }
            }
        }
    }
}

enum ServerManagerError: Error, LocalizedError {
    case startFailed(exitCode: Int32)
    case stopFailed(exitCode: Int32)
    case opencodeNotFound

    var errorDescription: String? {
        switch self {
        case .startFailed(let code):
            return "Failed to start server (exit code \(code))"
        case .stopFailed(let code):
            return "Failed to stop server (exit code \(code))"
        case .opencodeNotFound:
            return "opencode binary not found. Install it or set opencodePath in ~/.magents/config.json"
        }
    }
}

