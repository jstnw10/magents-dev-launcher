import Foundation

/// Utility for running shell commands asynchronously.
struct ShellRunner: Sendable {

    struct CommandResult: Sendable {
        let output: String
        let exitCode: Int32
    }

    /// Runs a shell command via `/bin/sh -c` and returns the combined stdout/stderr output.
    static func run(_ command: String, workingDirectory: String? = nil) async throws -> CommandResult {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = ["-c", command]
            if let wd = workingDirectory {
                process.currentDirectoryURL = URL(fileURLWithPath: wd)
            }
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
                return
            }

            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            continuation.resume(returning: CommandResult(output: output, exitCode: process.terminationStatus))
        }
    }
}

