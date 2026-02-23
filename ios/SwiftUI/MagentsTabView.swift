// Copyright 2015-present 650 Industries. All rights reserved.

import SwiftUI

struct MagentsTabView: View {
  @EnvironmentObject var viewModel: DevLauncherViewModel
  @StateObject private var store = MagentsDataStore.shared
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

      if store.items.isEmpty {
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
          ForEach(store.items) { item in
            HStack {
              Button {
                Task { try? await store.toggleItem(id: item.id) }
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
                Task { try? await store.removeItem(id: item.id) }
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

  // MARK: - Actions

  private func addItem() {
    let trimmed = newItemText.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return }
    let text = trimmed
    newItemText = ""
    Task { try? await store.addItem(text: text) }
  }
}

#Preview {
  MagentsTabView()
    .environmentObject(DevLauncherViewModel())
}

