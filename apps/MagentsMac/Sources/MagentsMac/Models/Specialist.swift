import Foundation

enum SpecialistSource: String, Codable, Sendable, Hashable {
    case builtin
    case user
}

struct SpecialistDefinition: Codable, Identifiable, Sendable, Hashable {
    var id: String  // filename without .md
    let name: String
    let description: String
    let modelTier: String?
    let roleReminder: String?
    let defaultModel: String?
    let systemPrompt: String
    let source: SpecialistSource
}

