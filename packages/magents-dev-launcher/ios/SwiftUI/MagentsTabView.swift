// Copyright 2015-present 650 Industries. All rights reserved.

import SwiftUI

struct MagentsTabView: View {
  @EnvironmentObject var viewModel: DevLauncherViewModel
  @StateObject private var store = MagentsDataStore.shared
  @State private var expandedParentIDs: Set<String> = []

  var body: some View {
    VStack(spacing: 0) {
      DevLauncherNavigationHeader()

      if store.isConnected {
        connectedView
      } else {
        fallbackView
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    #if os(tvOS)
    .background()
    #endif
    .onAppear {
      store.startSubscription()
    }
  }

  // MARK: - Connected: real-time agent list

  private var connectedView: some View {
    let parentAgents = store.agents.filter { $0.parentId == nil }
    let parentIDs = Set(parentAgents.map(\.id))
    let childrenByParentID = Dictionary(
      grouping: store.agents.filter { agent in
        guard let parentId = agent.parentId else {
          return false
        }
        return parentIDs.contains(parentId)
      },
      by: { $0.parentId ?? "" }
    )
    let unparentedChildren = store.agents.filter { agent in
      guard let parentId = agent.parentId else {
        return false
      }
      return !parentIDs.contains(parentId)
    }

      return VStack(spacing: 0) {
      if store.agents.isEmpty {
        Spacer()
        VStack(spacing: 12) {
          Image(systemName: "tray")
            .font(.system(size: 40))
            .foregroundColor(.secondary)
          Text("No agents yet")
            .font(.headline)
            .foregroundColor(.secondary)
          Text("Agents will appear here when available")
            .font(.subheadline)
            .foregroundColor(.secondary.opacity(0.7))
        }
        Spacer()
      } else {
        List {
          ForEach(parentAgents) { parent in
            parentCard(
              parent: parent,
              children: childrenByParentID[parent.id] ?? []
            )
          }

          if !unparentedChildren.isEmpty {
            unparentedCard(children: unparentedChildren)
          }
        }
        .listStyle(.plain)
      }
    }
  }

  private func parentCard(parent: MagentsAgent, children: [MagentsAgent]) -> some View {
    let isExpanded = expandedParentIDs.contains(parent.id)

    return VStack(alignment: .leading, spacing: 10) {
      Button {
        toggleParent(parent.id)
      } label: {
        HStack(spacing: 8) {
          Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
            .font(.caption.weight(.semibold))
            .foregroundColor(.secondary)

          statusRow(agent: parent, accessibilityRole: "Parent")
        }
      }
      .buttonStyle(.plain)

      if isExpanded {
        if children.isEmpty {
          Text("No child agents")
            .font(.footnote)
            .foregroundColor(.secondary)
            .padding(.leading, 20)
        } else {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(children) { child in
              statusRow(agent: child, accessibilityRole: "Child")
                .padding(.leading, 20)
            }
          }
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(Color(.secondarySystemBackground))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
    )
    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
    .listRowBackground(Color.clear)
  }

  private func unparentedCard(children: [MagentsAgent]) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Unparented")
        .font(.subheadline.weight(.semibold))
        .foregroundColor(.secondary)

      ForEach(children) { child in
        statusRow(agent: child, accessibilityRole: "Unparented child")
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(Color(.secondarySystemBackground))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
    )
    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
    .listRowBackground(Color.clear)
  }

  private func statusRow(agent: MagentsAgent, accessibilityRole: String) -> some View {
    HStack(spacing: 8) {
      Circle()
        .fill(statusColor(for: agent.status))
        .frame(width: 8, height: 8)
      Text(agent.name)
      Spacer(minLength: 8)
      Text(agent.status)
        .font(.caption)
        .foregroundColor(statusColor(for: agent.status))
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(accessibilityRole): \(agent.name), status \(agent.status)")
  }

  private func statusColor(for status: String) -> Color {
    switch status.lowercased() {
    case "running":
      return .blue
    case "idle":
      return .gray
    case "done":
      return .green
    case "error":
      return .red
    default:
      return .gray
    }
  }

  private func toggleParent(_ parentID: String) {
    if expandedParentIDs.contains(parentID) {
      expandedParentIDs.remove(parentID)
    } else {
      expandedParentIDs.insert(parentID)
    }
  }

  // MARK: - Fallback: provider not registered

  private var fallbackView: some View {
    VStack(spacing: 16) {
      Spacer()
      Image(systemName: "exclamationmark.triangle")
        .font(.system(size: 40))
        .foregroundColor(.orange)
      Text("Convex Not Configured")
        .font(.headline)
      Text("Set the `convexUrl` option in your Expo plugin config to connect to a Convex backend.")
        .font(.subheadline)
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 40)
      Spacer()
    }
  }
}

#Preview {
  MagentsTabView()
    .environmentObject(DevLauncherViewModel())
}
