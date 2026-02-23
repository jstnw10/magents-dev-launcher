// Copyright 2015-present 650 Industries. All rights reserved.

import SwiftUI

#if canImport(ConvexMobile)

// MARK: - Convex-enabled Magents tab

struct MagentsTabView: View {
  @EnvironmentObject var viewModel: DevLauncherViewModel
  @StateObject private var convex = ConvexService.shared
  @State private var newItemText = ""

  var body: some View {
    VStack(spacing: 0) {
      // Header
      HStack {
        Text("Magents")
          .font(.largeTitle)
          .fontWeight(.bold)
        Spacer()
      }
      .padding(.horizontal)
      .padding(.top, 16)
      .padding(.bottom, 8)

      if convex.isConnected {
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
      convex.startItemsSubscription()
    }
  }

  // MARK: - Connected: real-time item list

  private var connectedView: some View {
    VStack(spacing: 0) {
      // Add item bar
      HStack(spacing: 8) {
        TextField("Add a new item…", text: $newItemText)
          .textFieldStyle(.roundedBorder)
          .submitLabel(.done)
          .onSubmit { addItem() }

        Button(action: addItem) {
          Image(systemName: "plus.circle.fill")
            .font(.title2)
        }
        .disabled(newItemText.trimmingCharacters(in: .whitespaces).isEmpty)
      }
      .padding(.horizontal)
      .padding(.bottom, 12)

      if convex.items.isEmpty {
        Spacer()
        VStack(spacing: 12) {
          Image(systemName: "tray")
            .font(.system(size: 40))
            .foregroundColor(.secondary)
          Text("No items yet")
            .font(.headline)
            .foregroundColor(.secondary)
          Text("Add your first item above")
            .font(.subheadline)
            .foregroundColor(.secondary.opacity(0.7))
        }
        Spacer()
      } else {
        List {
          ForEach(convex.items) { item in
            HStack {
              Button {
                Task { try? await convex.toggleItem(id: item._id) }
              } label: {
                Image(systemName: item.isCompleted ? "checkmark.circle.fill" : "circle")
                  .foregroundColor(item.isCompleted ? .green : .secondary)
                  .font(.title3)
              }
              .buttonStyle(.plain)

              Text(item.text)
                .strikethrough(item.isCompleted)
                .foregroundColor(item.isCompleted ? .secondary : .primary)

              Spacer()

              Button(role: .destructive) {
                Task { try? await convex.removeItem(id: item._id) }
              } label: {
                Image(systemName: "trash")
                  .font(.subheadline)
                  .foregroundColor(.red.opacity(0.7))
              }
              .buttonStyle(.plain)
            }
          }
        }
        .listStyle(.plain)
      }
    }
  }

  // MARK: - Fallback: deployment URL not configured

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

  // MARK: - Actions

  private func addItem() {
    let trimmed = newItemText.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return }
    let text = trimmed
    newItemText = ""
    Task { try? await convex.addItem(text: text) }
  }
}

#else

// MARK: - Fallback when ConvexMobile is not available

struct MagentsTabView: View {
  @EnvironmentObject var viewModel: DevLauncherViewModel

  var body: some View {
    VStack(spacing: 0) {
      Spacer()

      VStack(spacing: 16) {
        Image(systemName: "sparkles")
          .resizable()
          .frame(width: 56, height: 56)
          .opacity(0.3)

        Text("Magents")
          .font(.largeTitle)
          .fontWeight(.bold)

        Text("To enable real-time features, set `convexUrl` in your Expo plugin config to add the Convex SDK.")
          .font(.subheadline)
          .foregroundColor(.secondary)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 40)
      }

      Spacer()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    #if os(tvOS)
    .background()
    #endif
  }
}

#endif

#Preview {
  MagentsTabView()
    .environmentObject(DevLauncherViewModel())
}

