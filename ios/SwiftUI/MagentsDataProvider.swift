// Copyright 2015-present 650 Industries. All rights reserved.

import Foundation
import Combine

/// A single data item displayed in the Magents tab.
public struct MagentsItem: Identifiable {
    public let id: String
    public let text: String
    public let isCompleted: Bool

    public init(id: String, text: String, isCompleted: Bool) {
        self.id = id
        self.text = text
        self.isCompleted = isCompleted
    }
}

/// Protocol that data providers must implement.
/// The implementation lives in the app target (not the pod).
@MainActor
public protocol MagentsDataProvider: AnyObject {
    /// Begin real-time subscription. Call `MagentsDataStore.shared.update(items:)` when data changes.
    func startSubscription()
    func addItem(text: String) async throws
    func toggleItem(id: String) async throws
    func removeItem(id: String) async throws
}

