import Foundation

struct ServerInfo: Codable, Sendable {
    let pid: Int
    let port: Int
    let url: String
    let startedAt: String
}

