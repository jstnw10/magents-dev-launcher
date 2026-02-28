import Foundation
import SwiftUI

// MARK: - Tab Content Type

enum TabContentType: Hashable, Codable {
    case chat(agentId: String)
    case note(noteId: String)
    case spec(workspaceId: String)
    case workspaceBrowser
}

// MARK: - Tab Item

struct TabItem: Identifiable, Hashable {
    let id: UUID
    var title: String
    var icon: String  // SF Symbol name
    var contentType: TabContentType
    var workspaceId: String?

    init(
        id: UUID = UUID(),
        title: String,
        icon: String,
        contentType: TabContentType,
        workspaceId: String? = nil
    ) {
        self.id = id
        self.title = title
        self.icon = icon
        self.contentType = contentType
        self.workspaceId = workspaceId
    }
}

