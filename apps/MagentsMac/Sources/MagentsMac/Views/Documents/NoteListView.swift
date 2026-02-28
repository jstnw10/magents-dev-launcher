import SwiftUI
import Observation

/// View model for listing workspace notes.
@MainActor
@Observable
final class NoteListViewModel {
    var notes: [Note] = []
    var isLoading = false
    var searchText = ""

    private let fileManager = WorkspaceFileManager()

    var filteredNotes: [Note] {
        let sorted = notes.sorted { $0.updatedAt > $1.updatedAt }
        if searchText.isEmpty { return sorted }
        let query = searchText.lowercased()
        return sorted.filter {
            $0.title.lowercased().contains(query)
                || $0.content.lowercased().contains(query)
                || $0.tags.contains(where: { $0.lowercased().contains(query) })
        }
    }

    func loadNotes(workspacePath: String) async {
        isLoading = true
        do {
            notes = try await fileManager.listNotes(workspacePath: workspacePath)
        } catch {
            notes = []
        }
        isLoading = false
    }
}

// MARK: - Note List View

/// Lists all notes for a workspace with search, tags, and preview.
struct NoteListView: View {
    let workspacePath: String
    @Environment(TabManager.self) private var tabManager

    @State private var viewModel = NoteListViewModel()

    var body: some View {
        VStack(spacing: 0) {
            // Search bar
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search notes…", text: $viewModel.searchText)
                    .textFieldStyle(.plain)
                if !viewModel.searchText.isEmpty {
                    Button {
                        viewModel.searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(10)

            Divider()

            // Content
            if viewModel.isLoading {
                Spacer()
                ProgressView()
                Spacer()
            } else if viewModel.filteredNotes.isEmpty {
                Spacer()
                VStack(spacing: 12) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 40))
                        .foregroundStyle(.tertiary)
                    Text("No notes yet")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            } else {
                List(viewModel.filteredNotes) { note in
                    NoteRowView(note: note)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            openNote(note)
                        }
                }
                .listStyle(.inset)
            }
        }
        .task {
            await viewModel.loadNotes(workspacePath: workspacePath)
        }
    }

    private func openNote(_ note: Note) {
        let tab = TabItem(
            title: note.title,
            icon: "note.text",
            contentType: .note(noteId: note.id)
        )
        tabManager.openTab(tab)
    }
}

// MARK: - Note Row

struct NoteRowView: View {
    let note: Note

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(note.title)
                .font(.headline)
                .lineLimit(1)

            // Preview: first non-empty, non-heading line
            let preview = firstContentLine(note.content)
            if !preview.isEmpty {
                Text(preview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            HStack(spacing: 6) {
                // Tags
                ForEach(note.tags.prefix(3), id: \.self) { tag in
                    Text(tag)
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(.quaternary)
                        .clipShape(Capsule())
                }

                Spacer()

                Text(note.updatedAt.prefix(10))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }

    private func firstContentLine(_ content: String) -> String {
        let lines = content.components(separatedBy: "\n")
        return lines.first(where: {
            let t = $0.trimmingCharacters(in: .whitespaces)
            return !t.isEmpty && !t.hasPrefix("#")
        }) ?? ""
    }
}

