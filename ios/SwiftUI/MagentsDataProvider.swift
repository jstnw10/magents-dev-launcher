// Copyright 2015-present 650 Industries. All rights reserved.

import Foundation
import Combine

/// A single data item displayed in the Magents tab.
struct MagentsItem: Identifiable {
    let id: String
    let text: String
    let isCompleted: Bool
}

/// Protocol that data providers must implement.
/// The implementation lives in the app target (not the pod).
@MainActor
protocol MagentsDataProvider: AnyObject {
    /// Begin real-time subscription. Call `MagentsDataStore.shared.update(items:)` when data changes.
    func startSubscription()
    func addItem(text: String) async throws
    func toggleItem(id: String) async throws
    func removeItem(id: String) async throws
}

