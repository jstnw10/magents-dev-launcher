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
  s.vendored_frameworks = 'libconvexmobile-rs.xcframework'
  s.preserve_paths = 'libconvexmobile-rs.xcframework/**/*'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_INCLUDE_PATHS' => [
      '$(PODS_TARGET_SRCROOT)/libconvexmobile-rs.xcframework/ios-arm64/Headers',
      '$(PODS_TARGET_SRCROOT)/libconvexmobile-rs.xcframework/ios-arm64-simulator/Headers',
    ].join(' '),
  }

  # Force-load ensures ALL symbols from the Rust static lib are available at link time.
  # The xcframework copy script places the correct platform slice into PODS_XCFRAMEWORKS_BUILD_DIR.
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS' => '$(inherited) -force_load "$(PODS_XCFRAMEWORKS_BUILD_DIR)/ConvexMobile/libconvexmobile.a"',
  }
end

