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
        SRC_SLICE="$XCFW_SRC/ios-arm64-simulator"
      elif [[ "$PLATFORM_NAME" == "macosx" ]]; then
        SRC_SLICE="$XCFW_SRC/macos-arm64"
      else
        SRC_SLICE="$XCFW_SRC/ios-arm64"
      fi
      rsync -a --delete "$SRC_SLICE/" "$XCFW_DST/"

      # Copy FFI module headers into the pod's own build directory so dependent
      # pods (e.g. expo-dev-launcher) can resolve the transitive 'convexmobileFFI'
      # Clang module when they 'import ConvexMobile'. CocoaPods adds this directory
      # to dependent pods' SWIFT_INCLUDE_PATHS (-I), enabling implicit module map
      # discovery by the Swift compiler's embedded Clang.
      mkdir -p "${CONFIGURATION_BUILD_DIR}"
      cp "$SRC_SLICE/Headers/module.modulemap" "${CONFIGURATION_BUILD_DIR}/module.modulemap"
      cp "$SRC_SLICE/Headers/convexmobileFFI.h" "${CONFIGURATION_BUILD_DIR}/convexmobileFFI.h"
    SCRIPT
    :execution_position => :before_compile,
  }

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # Point to CONFIGURATION_BUILD_DIR where the script phase copies FFI headers.
    # This is the ONLY location for the convexmobileFFI module to avoid redefinition.
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(CONFIGURATION_BUILD_DIR)"',
  }

  # Force-load ensures ALL symbols from the Rust static lib are available at link time.
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS' => '$(inherited) -force_load "$(PODS_CONFIGURATION_BUILD_DIR)/XCFrameworkIntermediates/convexmobile-rs/libconvexmobile.a"',
  }
end

