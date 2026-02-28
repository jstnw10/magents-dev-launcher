import Foundation
import os

/// Represents a single Server-Sent Event from the OpenCode server.
struct SSEEvent: Sendable {
    let event: String?
    let data: String
    let id: String?
}

/// Client for consuming Server-Sent Events from the OpenCode server.
/// Connects to the SSE endpoint and delivers events via an AsyncStream.
final class SSEClient: NSObject, @unchecked Sendable, URLSessionDataDelegate {
    private let url: URL
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private let buffer = OSAllocatedUnfairLock(initialState: "")
    private let continuationLock = OSAllocatedUnfairLock<AsyncStream<SSEEvent>.Continuation?>(initialState: nil)

    init(baseURL: URL) {
        self.url = baseURL.appendingPathComponent("sse")
        super.init()
    }

    /// Connect and return an AsyncStream of SSE events.
    func connect() -> AsyncStream<SSEEvent> {
        return AsyncStream { continuation in
            self.continuationLock.withLock { $0 = continuation }

            var request = URLRequest(url: self.url)
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.timeoutInterval = 3600

            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 3600
            config.timeoutIntervalForResource = 3600
            let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
            self.session = session

            let task = session.dataTask(with: request)
            self.task = task
            task.resume()

            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }

    /// Disconnect from the SSE stream and clean up.
    func disconnect() {
        task?.cancel()
        task = nil
        continuationLock.withLock { cont in
            cont?.finish()
            cont = nil
        }
        session?.invalidateAndCancel()
        session = nil
    }

    // MARK: - URLSessionDataDelegate

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }

        let events = buffer.withLock { buf -> [SSEEvent] in
            buf += text
            var parsed: [SSEEvent] = []

            // SSE events are separated by double newlines
            while let range = buf.range(of: "\n\n") {
                let block = String(buf[buf.startIndex..<range.lowerBound])
                buf = String(buf[range.upperBound...])

                if let event = Self.parseSSEBlock(block) {
                    parsed.append(event)
                }
            }
            return parsed
        }

        for event in events {
            continuationLock.withLock { _ = $0?.yield(event) }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            print("[SSEClient] Connection ended with error: \(error.localizedDescription)")
        }
        continuationLock.withLock { cont in
            cont?.finish()
            cont = nil
        }
    }

    // MARK: - Parsing

    private static func parseSSEBlock(_ block: String) -> SSEEvent? {
        var eventType: String?
        var data = ""
        var id: String?

        for line in block.components(separatedBy: "\n") {
            if line.hasPrefix("event:") {
                eventType = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                let value = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                if !data.isEmpty { data += "\n" }
                data += value
            } else if line.hasPrefix("id:") {
                id = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            }
        }

        guard !data.isEmpty else { return nil }
        return SSEEvent(event: eventType, data: data, id: id)
    }
}

