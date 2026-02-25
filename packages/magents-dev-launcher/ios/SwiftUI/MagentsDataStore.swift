// Copyright 2015-present 650 Industries. All rights reserved.

import Foundation
import Combine
import SwiftUI

/// Central data store for the Magents tab.
/// Views observe this object. The actual data provider is registered from the app target.
@MainActor
public final class MagentsDataStore: ObservableObject {
    public static let shared = MagentsDataStore()

    @Published public private(set) var workspaces: [MagentsWorkspace] = []
    @Published public private(set) var isConnected: Bool = false

    public private(set) var provider: MagentsDataProvider?

    /// Called from the app target's generated bridge to register the Convex provider.
    public static func register(provider: MagentsDataProvider) {
        shared.provider = provider
        shared.isConnected = true
    }

    /// Called by the provider when workspaces change.
    public func update(workspaces: [MagentsWorkspace]) {
        self.workspaces = workspaces
    }

    /// Attempts to find and register a MagentsDataProvider from the app target.
    private func discoverProvider() {
        guard provider == nil else { return }
        guard let cls = NSClassFromString("ConvexMagentsProvider") as? NSObject.Type else { return }
        let instance = cls.init()
        guard let discovered = instance as? MagentsDataProvider else { return }
        Self.register(provider: discovered)
    }

    public func startSubscription() {
        discoverProvider()
        provider?.startSubscription()
    }
}
