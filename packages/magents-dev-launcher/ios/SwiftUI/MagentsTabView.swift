// Copyright 2015-present 650 Industries. All rights reserved.

import SwiftUI

struct MagentsTabView: View {
  @EnvironmentObject var viewModel: DevLauncherViewModel
  @StateObject private var store = MagentsDataStore.shared

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

  // MARK: - Connected: real-time workspace list

  private var connectedView: some View {
    VStack(spacing: 0) {
      if store.workspaces.isEmpty {
        Spacer()
        VStack(spacing: 12) {
          Image(systemName: "tray")
            .font(.system(size: 40))
            .foregroundColor(.secondary)
          Text("No workspaces yet")
            .font(.headline)
            .foregroundColor(.secondary)
          Text("Workspaces will appear here when created via CLI")
            .font(.subheadline)
            .foregroundColor(.secondary.opacity(0.7))
        }
        Spacer()
      } else {
        List {
          ForEach(store.workspaces) { workspace in
            WorkspaceRow(workspace: workspace) {
              viewModel.openApp(url: workspace.tunnelUrl!)
            }
            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
            .listRowBackground(Color.clear)
          }
        }
        .listStyle(.plain)
      }
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

private struct WorkspaceRow: View {
  let workspace: MagentsWorkspace
  let onTap: () -> Void

  private var hasTunnel: Bool {
    workspace.tunnelUrl != nil
  }

  private var isActive: Bool {
    workspace.status.lowercased() == "active"
  }

  var body: some View {
    if hasTunnel {
      Button {
        onTap()
      } label: {
        rowContent
      }
      .buttonStyle(PlainButtonStyle())
    } else {
      rowContent
        .opacity(0.5)
    }
  }

  private var rowContent: some View {
    HStack(spacing: 10) {
      Circle()
        .fill(isActive ? Color.green : Color.gray)
        .frame(width: 10, height: 10)

      VStack(alignment: .leading, spacing: 2) {
        Text(workspace.title)
          .font(.headline)
          .foregroundColor(.primary)
          .lineLimit(1)
        Text(workspace.branch)
          .font(.caption)
          .foregroundColor(.secondary)
          .lineLimit(1)
      }

      Spacer()

      if hasTunnel {
        Image(systemName: "chevron.right")
          .font(.caption)
          .foregroundColor(.secondary)
      } else {
        Text("No tunnel")
          .font(.caption)
          .foregroundColor(.secondary)
      }
    }
    .padding()
    .background(Color.expoSecondarySystemBackground)
    .clipShape(RoundedRectangle(cornerRadius: 12))
  }
}

#Preview {
  MagentsTabView()
    .environmentObject(DevLauncherViewModel())
}
