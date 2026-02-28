import SwiftUI

// MARK: - Tab Item View

@available(macOS 26.0, *)
struct TabItemView: View {
    let tab: TabItem
    let isActive: Bool
    let glassNamespace: Namespace.ID
    let onSelect: () -> Void
    let onClose: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 6) {
                Image(systemName: tab.icon)
                    .font(.system(size: 12))

                Text(tab.title)
                    .font(.system(size: 12, weight: isActive ? .semibold : .regular))
                    .lineLimit(1)

                // Close button — visible on hover or when active
                if isHovering || isActive {
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .contentShape(Circle())
                } else {
                    // Reserve space so tabs don't shift
                    Color.clear
                        .frame(width: 12, height: 12)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovering = hovering
        }
        .if(isActive) { view in
            view
                .glassEffect(.regular.tint(.accentColor), in: .capsule)
                .glassEffectID(tab.id, in: glassNamespace)
        }
    }
}

// MARK: - Conditional Modifier Helper

private extension View {
    @ViewBuilder
    func `if`<Content: View>(
        _ condition: Bool,
        transform: (Self) -> Content
    ) -> some View {
        if condition {
            transform(self)
        } else {
            self
        }
    }
}

