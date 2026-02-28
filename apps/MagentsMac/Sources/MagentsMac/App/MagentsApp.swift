import SwiftUI

@main
struct MagentsApp: App {
    @State private var viewModel = WorkspaceViewModel()
    @State private var tabManager = TabManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(viewModel)
                .environment(tabManager)
        }
        .windowStyle(.automatic)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Tab") {
                    // Placeholder — will be wired to create-agent or workspace browser
                }
                .keyboardShortcut("t")
            }

            CommandGroup(after: .newItem) {
                Button("Close Tab") {
                    tabManager.closeActiveTab()
                }
                .keyboardShortcut("w")

                Divider()

                Button("Previous Tab") {
                    tabManager.selectPreviousTab()
                }
                .keyboardShortcut("[", modifiers: [.command, .shift])

                Button("Next Tab") {
                    tabManager.selectNextTab()
                }
                .keyboardShortcut("]", modifiers: [.command, .shift])

                Divider()

                ForEach(1...9, id: \.self) { index in
                    Button("Tab \(index)") {
                        tabManager.selectTab(at: index - 1)
                    }
                    .keyboardShortcut(
                        KeyEquivalent(Character(String(index))),
                        modifiers: .command
                    )
                }
            }

            SidebarCommands()
        }
    }
}

