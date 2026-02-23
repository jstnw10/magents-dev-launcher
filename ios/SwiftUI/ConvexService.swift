// Copyright 2015-present 650 Industries. All rights reserved.

#if canImport(ConvexMobile)
import ConvexMobile
import Combine
import Foundation

/// A Convex document representing a to-do item.
struct ConvexItem: Decodable, Identifiable {
  let _id: String
  let text: String
  let isCompleted: Bool

  var id: String { _id }
}

/// Singleton that manages a ``ConvexClient`` connection.
///
/// The deployment URL is read from the `ConvexDeploymentUrl` key in
/// `Info.plist` (injected by the Expo config plugin when `convexUrl`
/// is provided).
@MainActor
final class ConvexService: ObservableObject {
  static let shared = ConvexService()

  @Published var items: [ConvexItem] = []
  @Published var isConnected: Bool = false

  private let client: ConvexClient?
  private var cancellables = Set<AnyCancellable>()

  private init() {
    guard let url = Bundle.main.infoDictionary?["ConvexDeploymentUrl"] as? String,
          !url.isEmpty else {
      client = nil
      isConnected = false
      return
    }

    client = ConvexClient(deploymentUrl: url)
    isConnected = true
  }

  // MARK: - Subscriptions

  /// Begins subscribing to `items:list` and keeps ``items`` up-to-date.
  func startItemsSubscription() {
    guard let client else { return }

    client.subscribe(to: "items:list", yielding: [ConvexItem].self)
      .replaceError(with: [])
      .receive(on: DispatchQueue.main)
      .assign(to: &$items)
  }

  // MARK: - Mutations

  /// Add a new item.
  func addItem(text: String) async throws {
    guard let client else { return }
    let _: String? = try await client.mutation("items:add", with: ["text": text])
  }

  /// Toggle the completion state of an item.
  func toggleItem(id: String) async throws {
    guard let client else { return }
    let _: String? = try await client.mutation("items:toggle", with: ["id": id])
  }

  /// Remove an item.
  func removeItem(id: String) async throws {
    guard let client else { return }
    let _: String? = try await client.mutation("items:remove", with: ["id": id])
  }
}
#endif

