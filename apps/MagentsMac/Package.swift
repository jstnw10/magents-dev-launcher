// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "MagentsMac",
    platforms: [
        // macOS 26.0 (Tahoe) — use .macOS(.v15) as placeholder if toolchain doesn't support .v26 yet
        .macOS(.v15)
    ],
    targets: [
        .executableTarget(
            name: "MagentsMac",
            path: "Sources/MagentsMac",
            exclude: ["Info.plist"],
            swiftSettings: [
                .swiftLanguageMode(.v6)
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/MagentsMac/Info.plist"
                ])
            ]
        )
    ]
)

