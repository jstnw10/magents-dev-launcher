import SwiftUI

struct StreamingIndicator: View {
    @State private var dotCount = 0

    private let timer = Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 6) {
            ProgressView()
                .controlSize(.small)

            Text("Thinking" + String(repeating: ".", count: dotCount + 1))
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.secondary.opacity(0.1))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal)
        .onReceive(timer) { _ in
            dotCount = (dotCount + 1) % 3
        }
    }
}

