import Foundation
import Observation

/// View model for loading and rendering workspace notes as HTML.
@MainActor
@Observable
final class DocumentViewModel {
    var note: Note?
    var isLoading = false
    var error: String?
    var htmlContent: String = ""

    private let fileManager = WorkspaceFileManager()
    private let renderer = MarkdownRenderer()

    /// Loads a note by ID and converts its markdown content to HTML.
    func loadNote(workspacePath: String, noteId: String) async {
        isLoading = true
        error = nil

        do {
            let loadedNote = try await fileManager.readNote(workspacePath: workspacePath, id: noteId)
            note = loadedNote
            htmlContent = renderer.render(loadedNote.content)
        } catch {
            self.error = "Failed to load note: \(error.localizedDescription)"
            htmlContent = renderer.render("*Error loading note.*")
        }

        isLoading = false
    }

    /// Shortcut to load the workspace specification (noteId = "spec").
    func loadSpec(workspacePath: String) async {
        await loadNote(workspacePath: workspacePath, noteId: "spec")
    }
}

