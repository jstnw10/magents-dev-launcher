// Copyright 2015-present 650 Industries. All rights reserved.

import Foundation
import Combine

/// A single agent displayed in the Magents tab.
public struct MagentsAgent: Identifiable {
    public let id: String
    public let name: String
    public let status: String
    public let parentId: String?

    public init(id: String, name: String, status: String, parentId: String? = nil) {
        self.id = id
        self.name = name
        self.status = status
        self.parentId = parentId
    }
}

/// Protocol that data providers must implement.
/// The implementation lives in the app target (not the pod).
@MainActor
public protocol MagentsDataProvider: AnyObject {
    /// Begin real-time subscription. Call `MagentsDataStore.shared.update(agents:)` when data changes.
    func startSubscription()
    /// Retained while existing UI flow still calls write operations.
    func addItem(text: String) async throws
    func toggleItem(id: String) async throws
    func removeItem(id: String) async throws
}
