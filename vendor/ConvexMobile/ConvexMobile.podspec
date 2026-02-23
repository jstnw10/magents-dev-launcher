Pod::Spec.new do |s|
  s.name           = 'ConvexMobile'
  s.version        = '0.8.1'
  s.summary        = 'Convex client for iOS (vendored from convex-swift)'
  s.description    = 'Vendored build of the convex-swift SDK including the pre-built Rust core binary.'
  s.homepage       = 'https://github.com/get-convex/convex-swift'
  s.license        = { :type => 'Apache-2.0', :file => 'LICENSE' }
  s.author         = 'Convex, Inc.'
  s.source         = { :path => '.' }

  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.2'
  s.static_framework = true

  s.source_files   = 'Sources/ConvexMobile/**/*.swift', 'Sources/UniFFI/**/*.swift'
  s.preserve_paths = 'libconvexmobile-rs.xcframework/**/*'

  # NOTE: We intentionally do NOT use vendored_frameworks for the Rust xcframework.
  # CocoaPods would auto-generate -l"convexmobile" which collides with -l"ConvexMobile"
  # (the Swift pod output) on case-insensitive macOS filesystems (APFS default),
  # causing 450+ duplicate symbol errors. Instead, we copy the correct platform slice
  # via a script phase and force-load it directly.

  s.script_phase = {
    :name => 'Copy Rust XCFramework Slice',
    :script => <<~SCRIPT,
      set -euo pipefail
      XCFW_SRC="${PODS_TARGET_SRCROOT}/libconvexmobile-rs.xcframework"
      XCFW_DST="${PODS_CONFIGURATION_BUILD_DIR}/XCFrameworkIntermediates/convexmobile-rs"
      mkdir -p "$XCFW_DST"
      if [[ "$PLATFORM_NAME" == *"simulator"* ]]; then
        rsync -a --delete "$XCFW_SRC/ios-arm64-simulator/" "$XCFW_DST/"
      elif [[ "$PLATFORM_NAME" == "macosx" ]]; then
        rsync -a --delete "$XCFW_SRC/macos-arm64/" "$XCFW_DST/"
      else
        rsync -a --delete "$XCFW_SRC/ios-arm64/" "$XCFW_DST/"
      fi
    SCRIPT
    :execution_position => :before_compile,
  }

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_CONFIGURATION_BUILD_DIR)/XCFrameworkIntermediates/convexmobile-rs/Headers"',
  }

  # Force-load ensures ALL symbols from the Rust static lib are available at link time.
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS' => '$(inherited) -force_load "$(PODS_CONFIGURATION_BUILD_DIR)/XCFrameworkIntermediates/convexmobile-rs/libconvexmobile.a"',
  }
end

