// Copyright 2015-present 650 Industries. All rights reserved.

import Foundation
import Combine
import SwiftUI

/// Central data store for the Magents tab.
/// Views observe this object. The actual data provider is registered from the app target.
@MainActor
final class MagentsDataStore: ObservableObject {
    static let shared = MagentsDataStore()

    @Published private(set) var items: [MagentsItem] = []
    @Published private(set) var isConnected: Bool = false

    private(set) var provider: MagentsDataProvider?

    /// Called from the app target's generated bridge to register the Convex provider.
    static func register(provider: MagentsDataProvider) {
        shared.provider = provider
        shared.isConnected = true
    }

    /// Called by the provider when items change.
    func update(items: [MagentsItem]) {
        self.items = items
    }

    // MARK: - Forwarded actions

    func startSubscription() {
        provider?.startSubscription()
    }

    func addItem(text: String) async throws {
        try await provider?.addItem(text: text)
    }

    func toggleItem(id: String) async throws {
        try await provider?.toggleItem(id: id)
    }

    func removeItem(id: String) async throws {
        try await provider?.removeItem(id: id)
    }
}

