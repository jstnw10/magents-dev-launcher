import SwiftUI

// MARK: - Tab Bar View

struct TabBarView: View {
    @Bindable var tabManager: TabManager
    @Namespace private var tabBarNamespace

    var body: some View {
        GlassEffectContainer {
            if tabManager.tabs.isEmpty {
                emptyState
            } else {
                tabStrip
            }
        }
    }

    // MARK: - Tab Strip

    private var tabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(tabManager.tabs) { tab in
                    TabItemView(
                        tab: tab,
                        isActive: tabManager.activeTabId == tab.id,
                        glassNamespace: tabBarNamespace,
                        onSelect: { tabManager.openTab(tab) },
                        onClose: { tabManager.closeTab(id: tab.id) }
                    )
                    .draggable(tab.id.uuidString) {
                        Text(tab.title)
                            .padding(8)
                    }
                    .dropDestination(for: String.self) { items, _ in
                        guard let droppedIdString = items.first,
                              let droppedId = UUID(uuidString: droppedIdString),
                              let fromIndex = tabManager.tabs.firstIndex(where: { $0.id == droppedId }),
                              let toIndex = tabManager.tabs.firstIndex(where: { $0.id == tab.id })
                        else { return false }
                        tabManager.moveTab(
                            from: IndexSet(integer: fromIndex),
                            to: toIndex > fromIndex ? toIndex + 1 : toIndex
                        )
                        return true
                    }
                    .contextMenu {
                        Button("Close") {
                            tabManager.closeTab(id: tab.id)
                        }
                        Button("Close Others") {
                            tabManager.closeOtherTabs(keeping: tab.id)
                        }
                        Divider()
                        Button("Close All") {
                            tabManager.closeAllTabs()
                        }
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
        .glassEffect(.regular, in: .rect(cornerRadius: 10))
        .animation(.smooth(duration: 0.25), value: tabManager.activeTabId)
    }

    // MARK: - Empty State

    private var emptyState: some View {
        HStack {
            Spacer()
            Text("No tabs open")
                .font(.system(size: 12))
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .rect(cornerRadius: 10))
    }
}

