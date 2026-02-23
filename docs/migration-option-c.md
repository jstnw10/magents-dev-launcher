# Migration Plan: Option C (App-Target Bridge Pattern)

## Goal

Replace the vendored CocoaPods wrapper (Option B) with a protocol-based bridge pattern (Option C) that keeps ConvexMobile on the app target via SPM and communicates with the pod through a generated bridge file. This eliminates 147MB of vendored binaries and all the podspec complexity.

## How It Works

```
┌─────────────────────────────────────────────────────┐
│  App Target (SPM available)                         │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │  Generated: ConvexMagentsProvider.swift      │    │
│  │  - import ConvexMobile  ✅ (SPM on this     │    │
│  │    target)                                   │    │
│  │  - implements MagentsDataProvider protocol   │    │
│  │  - registers itself with MagentsDataStore    │    │
│  └──────────────────┬──────────────────────────┘    │
│                     │ registers at startup           │
└─────────────────────┼───────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────┐
│  expo-dev-launcher Pod (no ConvexMobile dependency) │
│                                                     │
│  MagentsDataStore (ObservableObject)                │
│    .provider: MagentsDataProvider?                  │
│    .items: [MagentsItem]                            │
│    .isConnected: Bool                               │
│                                                     │
│  MagentsTabView → uses MagentsDataStore             │
│  (no #if canImport, no import ConvexMobile)         │
└─────────────────────────────────────────────────────┘
```

## Prerequisites

- Current Option B implementation is working and merged to main ✅
- Convex backend deployed at `https://gregarious-aardvark-924.convex.cloud/` ✅
- Test app at `../magents-test-app` ✅

## Detailed Steps

### Step 1: Define the protocol and data store in the pod

Create two new files in `ios/SwiftUI/`:

**`ios/SwiftUI/MagentsDataProvider.swift`** — The bridge protocol (no Convex dependency):

```swift
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
```

**`ios/SwiftUI/MagentsDataStore.swift`** — The concrete ObservableObject that views consume:

```swift
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
```

### Step 2: Update MagentsTabView to use the data store

Replace the current `#if canImport(ConvexMobile)` dual-implementation with a single implementation that uses `MagentsDataStore`:

- Remove `#if canImport(ConvexMobile)` / `#else` / `#endif` guards entirely
- Replace `@StateObject private var convex = ConvexService.shared` → `@StateObject private var store = MagentsDataStore.shared`
- Replace `convex.items` → `store.items`
- Replace `convex.isConnected` → `store.isConnected`
- Replace `convex.startItemsSubscription()` → `store.startSubscription()`
- Replace `convex.addItem(text:)` → `store.addItem(text:)`
- Replace `convex.toggleItem(id:)` → `store.toggleItem(id:)`
- Replace `convex.removeItem(id:)` → `store.removeItem(id:)`
- Replace `item._id` → `item.id` (since `MagentsItem.id` is a direct property)
- Keep the fallback UI for when `store.isConnected == false` (inline, not behind `#if`)

The `#else` fallback view (lines 141-178) becomes the `fallbackView` shown when `store.isConnected == false`. This is already mostly the pattern in the current Convex-enabled branch (lines 111-128).

### Step 3: Delete ConvexService.swift

`ios/SwiftUI/ConvexService.swift` is replaced by the generated bridge file. Delete it entirely.

### Step 4: Update the podspec

In `expo-dev-launcher.podspec`:
- Remove `s.dependency 'ConvexMobile'` (line 112)

That's it. No more CocoaPods dependency on ConvexMobile.

### Step 5: Update the config plugin

In `plugin/src/withDevLauncher.ts`:

**Replace `withConvexPod`** (which appends a pod line to Podfile) **with two new functions:**

#### 5a. `withConvexSPM` — Add SPM dependency to app target

Use `withXcodeProject` to add:
1. `XCRemoteSwiftPackageReference` for `https://github.com/get-convex/convex-swift` (version 0.8.1+)
2. `XCSwiftPackageProductDependency` for product `ConvexMobile` on the **main app target**

This is the same approach used in Phase 2 — it worked for the app target. The difference is now we don't need the pod to see it.

#### 5b. `withConvexBridge` — Generate the bridge Swift file

Use `withDangerousMod` to write a generated Swift file into the consumer app's `ios/` directory:

**Generated file: `ios/{AppName}/ConvexMagentsProvider.swift`**

```swift
// AUTO-GENERATED by expo-dev-launcher config plugin — do not edit
import ConvexMobile
import Combine
import Foundation

@MainActor
final class ConvexMagentsProvider: MagentsDataProvider {
    private let client: ConvexClient?
    private var cancellables = Set<AnyCancellable>()

    init() {
        guard let url = Bundle.main.infoDictionary?["ConvexDeploymentUrl"] as? String,
              !url.isEmpty else {
            client = nil
            return
        }
        client = ConvexClient(deploymentUrl: url)
    }

    func startSubscription() {
        guard let client else { return }

        // Subscribe and push results to MagentsDataStore
        client.subscribe(to: "items:list", yielding: [ConvexItem].self)
            .replaceError(with: [])
            .receive(on: DispatchQueue.main)
            .sink { items in
                MagentsDataStore.shared.update(items: items.map {
                    MagentsItem(id: $0._id, text: $0.text, isCompleted: $0.isCompleted)
                })
            }
            .store(in: &cancellables)
    }

    func addItem(text: String) async throws {
        guard let client else { return }
        let _: String? = try await client.mutation("items:add", with: ["text": text])
    }

    func toggleItem(id: String) async throws {
        guard let client else { return }
        let _: String? = try await client.mutation("items:toggle", with: ["id": id])
    }

    func removeItem(id: String) async throws {
        guard let client else { return }
        let _: String? = try await client.mutation("items:remove", with: ["id": id])
    }
}

/// Mirrors the Convex document shape for decoding.
private struct ConvexItem: Decodable {
    let _id: String
    let text: String
    let isCompleted: Bool
}

/// Registers the Convex provider at app launch.
private enum ConvexMagentsBootstrap {
    static let _: Void = {
        Task { @MainActor in
            MagentsDataStore.register(provider: ConvexMagentsProvider())
        }
    }()
}
```

> **Note on registration timing:** The tab view is only shown when the user opens the dev launcher, well after app startup. The `Task { @MainActor in ... }` approach is fine. If timing becomes an issue, an alternative is to call registration from `application(_:didFinishLaunchingWithOptions:)` via an Expo module lifecycle hook.

#### 5c. Update the plugin wiring

```typescript
// Convex integration
if (props.convexUrl) {
    config = withConvexSPM(config);           // Add SPM dependency
    config = withConvexBridge(config);         // Generate bridge file
    config = withConvexInfoPlist(config, props.convexUrl); // Inject URL
}
```

Note: all three are now **conditional** on `convexUrl`. If no URL is provided, no SPM package is added, no bridge file is generated, and the Magents tab just shows the fallback "not configured" UI.

### Step 6: Delete the vendor directory

```bash
rm -rf vendor/ConvexMobile/
```

This removes 147MB of vendored binaries from the repo.

### Step 7: Test in the test app

1. Update `../magents-test-app/package.json` to reference `main` (or the migration branch)
2. Run `bunx expo prebuild --clean -p ios`
3. Verify:
   - `ConvexMagentsProvider.swift` was generated in `ios/magentsTestApp/`
   - SPM dependency `convex-swift` appears in the Xcode project
   - `pod install` succeeds without `ConvexMobile` pod
   - Build succeeds
   - Magents tab shows real-time items from Convex

## Files Changed Summary

| File | Change |
|------|--------|
| `ios/SwiftUI/MagentsDataProvider.swift` | **NEW** — Protocol definition |
| `ios/SwiftUI/MagentsDataStore.swift` | **NEW** — Observable data store |
| `ios/SwiftUI/MagentsTabView.swift` | **MODIFY** — Remove `#if canImport`, use `MagentsDataStore` |
| `ios/SwiftUI/ConvexService.swift` | **DELETE** — Replaced by generated bridge |
| `expo-dev-launcher.podspec` | **MODIFY** — Remove `s.dependency 'ConvexMobile'` |
| `plugin/src/withDevLauncher.ts` | **MODIFY** — Replace `withConvexPod` with `withConvexSPM` + `withConvexBridge` |
| `vendor/ConvexMobile/` | **DELETE** — Entire directory (147MB) |

## Risks & Mitigations

### 1. Static initializer registration timing
**Risk:** The bridge provider might not register before `MagentsTabView` appears.
**Mitigation:** The tab view is only shown when the user manually opens the dev launcher. By that time, the static initializer has long since run. Add a 1-second retry in `MagentsDataStore` if `provider == nil` as a safety net.

### 2. SPM resolution during `pod install`
**Risk:** SPM packages are resolved by Xcode, not CocoaPods. If `pod install` runs before Xcode resolves packages, the build might fail.
**Mitigation:** SPM resolution happens at Xcode build time, which is always after `pod install`. The pod doesn't import ConvexMobile, so this is a non-issue.

### 3. Xcode project manipulation via config plugin
**Risk:** The `withXcodeProject` modifier for adding SPM packages can be fragile across Expo SDK versions.
**Mitigation:** We already had this working in Phase 2. Pin to a specific `convex-swift` version. Test after each Expo SDK upgrade.

### 4. Generated file conflicts on re-prebuild
**Risk:** Running `expo prebuild` twice could duplicate the generated file.
**Mitigation:** Check if the file exists before writing (same pattern as `withConvexPod` checking `podfileContents.includes(podLine)`).

## Estimated Effort

| Step | Estimate |
|------|----------|
| 1. Protocol + data store | 30 min |
| 2. Update MagentsTabView | 30 min |
| 3. Delete ConvexService | 5 min |
| 4. Update podspec | 5 min |
| 5. Config plugin (SPM + bridge gen) | 1-2 hours |
| 6. Delete vendor dir | 5 min |
| 7. Test in test app + debug | 1-2 hours |
| **Total** | **~3-5 hours** |

## Rollback Plan

If the migration fails mid-way:
1. `git checkout main` — Option B is fully working on `main`
2. In the test app: `bunx expo prebuild --clean -p ios` to restore
3. The vendored CocoaPods approach is stable and can remain as the fallback

## Future Extensibility

Once Option C is in place, the `MagentsDataProvider` protocol makes it trivial to:
- Swap Convex for another backend (Firebase, Supabase, etc.) — just generate a different bridge file
- Add mock providers for testing — implement the protocol with static data
- Support multiple data sources — register different providers for different tabs
- Add Android support — the protocol pattern translates cleanly to Kotlin interfaces
