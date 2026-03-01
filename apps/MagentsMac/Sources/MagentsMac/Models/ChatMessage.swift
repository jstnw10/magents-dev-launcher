import Foundation

enum MessageRole: String, Codable, Sendable {
    case user
    case assistant
}

struct MessageTokens: Codable, Sendable {
    let input: Int
    let output: Int
}

// MARK: - Message Part Types

enum MessagePartType: String, Codable, Sendable {
    case text
    case reasoning
    case tool
    case stepStart = "step-start"
    case stepFinish = "step-finish"
}

enum ToolStatus: String, Codable, Sendable {
    case pending
    case running
    case completed
    case error
}

struct MessagePart: Identifiable, Sendable {
    let id: String
    let messageID: String
    let type: MessagePartType

    // Text / reasoning parts
    var text: String?

    // Tool parts
    var toolName: String?
    var toolCallID: String?
    var toolStatus: ToolStatus?
    var toolTitle: String?
    var toolInput: String?
    var toolOutput: String?
}

struct ConversationMessage: Identifiable, Sendable {
    var id: String { "\(role.rawValue)-\(timestamp)" }

    let role: MessageRole
    let content: String
    let parts: [MessagePart]
    let timestamp: String
    var tokens: MessageTokens?
    var cost: Double?
}

struct Conversation: Sendable {
    let agentId: String
    let sessionId: String
    var messages: [ConversationMessage]
}

/// A type-erased Codable value for the `parts` array which can contain any JSON.
struct AnyCodable: Codable, @unchecked Sendable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            value = NSNull()
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            try container.encodeNil()
        }
    }
}

