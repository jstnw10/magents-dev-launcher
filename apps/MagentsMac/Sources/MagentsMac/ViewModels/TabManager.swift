import Foundation
import SwiftUI
import Observation

// MARK: - Tab Manager

@MainActor
@Observable
final class TabManager {
    var tabs: [TabItem] = []
    var activeTabId: UUID?

    var activeTab: TabItem? {
        guard let activeTabId else { return nil }
        return tabs.first { $0.id == activeTabId }
    }

    // MARK: - Open / Switch

    /// Opens a tab. If a tab with the same contentType already exists, switches to it instead.
    func openTab(_ tab: TabItem) {
        if let existing = tabs.first(where: { $0.contentType == tab.contentType }) {
            activeTabId = existing.id
        } else {
            tabs.append(tab)
            activeTabId = tab.id
        }
    }

    // MARK: - Close

    func closeTab(id: UUID) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        let wasActive = activeTabId == id
        tabs.remove(at: index)

        if wasActive {
            if tabs.isEmpty {
                activeTabId = nil
            } else {
                // Select adjacent tab: prefer same index, fall back to previous
                let newIndex = min(index, tabs.count - 1)
                activeTabId = tabs[newIndex].id
            }
        }
    }

    func closeAllTabs() {
        tabs.removeAll()
        activeTabId = nil
    }

    func closeOtherTabs(keeping id: UUID) {
        tabs.removeAll { $0.id != id }
        activeTabId = id
    }

    // MARK: - Reorder

    func moveTab(from source: IndexSet, to destination: Int) {
        tabs.move(fromOffsets: source, toOffset: destination)
    }

    // MARK: - Navigation

    /// Select tab at 0-based index (for Cmd+1 through Cmd+9).
    func selectTab(at index: Int) {
        guard index >= 0, index < tabs.count else { return }
        activeTabId = tabs[index].id
    }

    /// Select the next tab (Cmd+Shift+]).
    func selectNextTab() {
        guard let activeTabId, !tabs.isEmpty else { return }
        guard let currentIndex = tabs.firstIndex(where: { $0.id == activeTabId }) else { return }
        let nextIndex = (currentIndex + 1) % tabs.count
        self.activeTabId = tabs[nextIndex].id
    }

    /// Select the previous tab (Cmd+Shift+[).
    func selectPreviousTab() {
        guard let activeTabId, !tabs.isEmpty else { return }
        guard let currentIndex = tabs.firstIndex(where: { $0.id == activeTabId }) else { return }
        let previousIndex = (currentIndex - 1 + tabs.count) % tabs.count
        self.activeTabId = tabs[previousIndex].id
    }

    /// Close the active tab (Cmd+W).
    func closeActiveTab() {
        guard let activeTabId else { return }
        closeTab(id: activeTabId)
    }
}

