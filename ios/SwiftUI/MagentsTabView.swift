// Copyright 2015-present 650 Industries. All rights reserved.

import SwiftUI

struct MagentsTabView: View {
  @EnvironmentObject var viewModel: DevLauncherViewModel

  var body: some View {
    VStack(spacing: 0) {
      Spacer()

      VStack(spacing: 16) {
        Image(systemName: "sparkles")
          .resizable()
          .frame(width: 56, height: 56)
          .opacity(0.3)

        Text("Magents")
          .font(.largeTitle)
          .fontWeight(.bold)

        Text("Custom developer tools and features")
          .font(.subheadline)
          .foregroundColor(.secondary)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 40)
      }

      Spacer()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    #if os(tvOS)
    .background()
    #endif
  }
}

#Preview {
  MagentsTabView()
    .environmentObject(DevLauncherViewModel())
}

