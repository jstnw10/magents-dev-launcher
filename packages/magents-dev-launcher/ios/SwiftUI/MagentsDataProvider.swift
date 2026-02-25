// Copyright 2015-present 650 Industries. All rights reserved.

import Foundation
import Combine

/// A single workspace displayed in the Magents tab.
public struct MagentsWorkspace: Identifiable {
    public let id: String
    public let title: String
    public let branch: String
    public let status: String
    public let tunnelUrl: String?

    public init(id: String, title: String, branch: String, status: String, tunnelUrl: String? = nil) {
        self.id = id
        self.title = title
        self.branch = branch
        self.status = status
        self.tunnelUrl = tunnelUrl
    }
}

/// Protocol that data providers must implement.
/// The implementation lives in the app target (not the pod).
@MainActor
public protocol MagentsDataProvider: AnyObject {
    /// Begin real-time subscription. Call `MagentsDataStore.shared.update(workspaces:)` when data changes.
    func startSubscription()
}
