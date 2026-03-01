import SwiftUI

// MARK: - Document Scan Animation

/// A cinematic document-scanning animation shown while content loads.
///
/// **Concept — "Holographic Materializer"**
///
/// The animation has three phases that play in sequence:
///
/// 1. **Grid phase** — A faint measurement grid fades in, setting the stage.
/// 2. **Scan phase** — A glowing beam sweeps downward. As it passes each
///    skeleton line, particles rush inward from random offsets and converge
///    into the line shape, shimmering with a holographic color shift.
/// 3. **Solidify phase** — The particles settle, the grid fades out, and the
///    skeleton lines become solid placeholders, ready to be replaced by
///    real content.
///
/// Everything is built from native SwiftUI primitives — no images, no
/// third-party libraries.
struct DocumentScanAnimation: View {
    // MARK: - Animation state

    @State private var appeared = false
    @State private var scanProgress: CGFloat = -0.10
    @State private var gridOpacity: Double = 0
    @State private var shimmerPhase: CGFloat = 0
    @State private var particleSpread: CGFloat = 1.0

    // MARK: - Timing

    private let scanDuration: Double = 2.4
    private let gridFadeIn: Double = 0.5
    private let particleConverge: Double = 2.0

    var body: some View {
        GeometryReader { geo in
            let height = geo.size.height
            let width = min(geo.size.width * 0.55, 400.0)

            ZStack {
                // Layer 1 — Measurement grid
                measurementGrid(width: width, height: height)
                    .opacity(gridOpacity)

                // Layer 2 — Document skeleton (masked by scan reveal)
                documentSkeleton(width: width)
                    .frame(width: width)
                    .mask(revealMask(totalHeight: height))
                    .overlay(
                        holographicShimmer(width: width, height: height)
                            .mask(
                                documentSkeleton(width: width)
                                    .frame(width: width)
                                    .mask(revealMask(totalHeight: height))
                            )
                    )

                // Layer 3 — Particle field
                particleField(width: width, height: height)
                    .mask(revealMask(totalHeight: height))

                // Layer 4 — Scan beam with lens flare
                scanBeamGroup(totalHeight: height, width: width)

                // Layer 5 — Corner brackets (scan frame)
                scanFrame(width: width, height: min(height, 500))
                    .opacity(gridOpacity)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .opacity(appeared ? 1 : 0)
        .onAppear {
            withAnimation(.easeIn(duration: 0.35)) {
                appeared = true
            }
            withAnimation(.easeIn(duration: gridFadeIn)) {
                gridOpacity = 0.6
            }
            startScanLoop()
            startShimmerLoop()
            startParticleConverge()
        }
    }

    // MARK: - Measurement Grid

    /// Faint blue-tinted grid lines that evoke a scanner / blueprint feel.
    private func measurementGrid(width: CGFloat, height: CGFloat) -> some View {
        Canvas { context, size in
            let cols = 20
            let rows = Int(height / (width / CGFloat(cols)))
            let cellW = width / CGFloat(cols)
            let cellH = cellW
            let originX = (size.width - width) / 2.0
            let originY = (size.height - CGFloat(rows) * cellH) / 2.0

            let fineColor = Color.accentColor.opacity(0.06)
            let majorColor = Color.accentColor.opacity(0.12)

            for col in 0...cols {
                let x = originX + CGFloat(col) * cellW
                var path = Path()
                path.move(to: CGPoint(x: x, y: originY))
                path.addLine(to: CGPoint(x: x, y: originY + CGFloat(rows) * cellH))
                let isMajor = col % 5 == 0
                context.stroke(
                    path,
                    with: .color(isMajor ? majorColor : fineColor),
                    lineWidth: isMajor ? 0.8 : 0.4
                )
            }

            for row in 0...rows {
                let y = originY + CGFloat(row) * cellH
                var path = Path()
                path.move(to: CGPoint(x: originX, y: y))
                path.addLine(to: CGPoint(x: originX + width, y: y))
                let isMajor = row % 5 == 0
                context.stroke(
                    path,
                    with: .color(isMajor ? majorColor : fineColor),
                    lineWidth: isMajor ? 0.8 : 0.4
                )
            }
        }
        .allowsHitTesting(false)
    }

    // MARK: - Document Skeleton

    /// Placeholder document shape — title, tags, paragraphs, code block.
    private func documentSkeleton(width: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Icon placeholder
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Color.secondary.opacity(0.08))
                .frame(width: 30, height: 30)
                .padding(.bottom, 14)

            // Title
            skeletonLine(widthFraction: 0.58, height: 14)
                .padding(.bottom, 6)
            skeletonLine(widthFraction: 0.32, height: 10)
                .padding(.bottom, 20)

            // Tags
            HStack(spacing: 6) {
                skeletonPill(width: 50)
                skeletonPill(width: 38)
                skeletonPill(width: 56)
            }
            .padding(.bottom, 24)

            // Section 1
            ForEach(0..<4, id: \.self) { i in
                skeletonLine(
                    widthFraction: i == 3 ? 0.52 : [0.92, 0.88, 0.95, 0.80][i],
                    height: 8
                )
                .padding(.bottom, 6)
            }

            Spacer().frame(height: 20)

            // Section 2 heading + paragraph
            skeletonLine(widthFraction: 0.42, height: 12)
                .padding(.bottom, 10)
            ForEach(0..<3, id: \.self) { i in
                skeletonLine(
                    widthFraction: i == 2 ? 0.38 : [0.85, 0.90, 0.60][i],
                    height: 8
                )
                .padding(.bottom, 6)
            }

            Spacer().frame(height: 20)

            // Code block
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color.secondary.opacity(0.04))
                .frame(height: 60)
                .overlay(alignment: .topLeading) {
                    VStack(alignment: .leading, spacing: 5) {
                        skeletonLine(widthFraction: 0.65, height: 6)
                        skeletonLine(widthFraction: 0.48, height: 6)
                        skeletonLine(widthFraction: 0.55, height: 6)
                    }
                    .padding(10)
                }

            Spacer()
        }
        .padding(28)
    }

    private func skeletonLine(widthFraction: CGFloat, height: CGFloat) -> some View {
        GeometryReader { geo in
            RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                .fill(Color.secondary.opacity(0.12))
                .frame(width: geo.size.width * widthFraction, height: height)
        }
        .frame(height: height)
    }

    private func skeletonPill(width: CGFloat) -> some View {
        Capsule()
            .fill(Color.secondary.opacity(0.08))
            .frame(width: width, height: 18)
    }

    // MARK: - Holographic Shimmer

    /// An animated gradient overlay that gives revealed content a
    /// holographic / iridescent color shift.
    private func holographicShimmer(width: CGFloat, height: CGFloat) -> some View {
        LinearGradient(
            colors: [
                Color.cyan.opacity(0.0),
                Color.cyan.opacity(0.12),
                Color.blue.opacity(0.10),
                Color.purple.opacity(0.10),
                Color.pink.opacity(0.08),
                Color.cyan.opacity(0.0),
            ],
            startPoint: UnitPoint(x: shimmerPhase - 0.3, y: 0),
            endPoint: UnitPoint(x: shimmerPhase + 0.3, y: 1)
        )
        .frame(width: width + 60, height: height)
        .allowsHitTesting(false)
    }

    // MARK: - Particle Field

    /// A field of tiny dots that collapse inward as `particleSpread`
    /// decreases, giving the illusion of matter assembling.
    private func particleField(width: CGFloat, height: CGFloat) -> some View {
        Canvas { context, size in
            let centerX = size.width / 2.0
            let topPad: CGFloat = 28

            // Seed-based "random" positions (deterministic per frame)
            let particles = generateParticles(count: 120, width: width, height: height)

            for p in particles {
                let targetX = centerX - width / 2 + p.targetX
                let targetY = topPad + p.targetY

                // Current position = lerp from scattered → target
                let spread = particleSpread
                let currentX = targetX + p.offsetX * spread
                let currentY = targetY + p.offsetY * spread

                let alpha = max(0, min(1, 1.0 - spread * 0.6)) * p.alpha

                let rect = CGRect(
                    x: currentX - p.size / 2,
                    y: currentY - p.size / 2,
                    width: p.size,
                    height: p.size
                )

                context.fill(
                    Circle().path(in: rect),
                    with: .color(p.color.opacity(alpha))
                )
            }
        }
        .allowsHitTesting(false)
    }

    // MARK: - Scan Beam

    /// The main scanning beam — a glowing line with a soft halo above and
    /// below, plus a central lens flare dot.
    private func scanBeamGroup(totalHeight: CGFloat, width: CGFloat) -> some View {
        let y = scanProgress * totalHeight

        return ZStack {
            // Upper trailing glow
            LinearGradient(
                colors: [
                    Color.accentColor.opacity(0),
                    Color.accentColor.opacity(0.05),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(width: width + 50, height: 70)
            .offset(y: -36)

            // Core beam
            Rectangle()
                .fill(
                    LinearGradient(
                        colors: [
                            Color.accentColor.opacity(0),
                            Color.accentColor.opacity(0.6),
                            Color.accentColor.opacity(0.9),
                            Color.accentColor.opacity(0.6),
                            Color.accentColor.opacity(0),
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .frame(width: width + 50, height: 1.5)
                .shadow(color: Color.accentColor.opacity(0.6), radius: 6, y: 0)
                .shadow(color: Color.accentColor.opacity(0.3), radius: 16, y: 0)

            // Lens flare — bright dot at center
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color.white.opacity(0.9),
                            Color.accentColor.opacity(0.5),
                            Color.accentColor.opacity(0),
                        ],
                        center: .center,
                        startRadius: 0,
                        endRadius: 10
                    )
                )
                .frame(width: 20, height: 20)
                .blendMode(.plusLighter)

            // Lower soft glow
            LinearGradient(
                colors: [
                    Color.accentColor.opacity(0.03),
                    Color.accentColor.opacity(0),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(width: width + 50, height: 24)
            .offset(y: 13)
        }
        .position(x: width / 2 + (UIConstants.horizontalInset), y: y)
        .allowsHitTesting(false)
    }

    // MARK: - Scan Frame (Corner Brackets)

    /// Four corner bracket marks that frame the scan area.
    private func scanFrame(width: CGFloat, height: CGFloat) -> some View {
        GeometryReader { geo in
            let cx = geo.size.width / 2
            let cy = geo.size.height / 2
            let halfW = width / 2
            let halfH = height / 2
            let arm: CGFloat = 18
            let lineWidth: CGFloat = 1.2

            let color = Color.accentColor.opacity(0.35)

            Canvas { context, _ in
                // Top-left
                var tl = Path()
                tl.move(to: CGPoint(x: cx - halfW, y: cy - halfH + arm))
                tl.addLine(to: CGPoint(x: cx - halfW, y: cy - halfH))
                tl.addLine(to: CGPoint(x: cx - halfW + arm, y: cy - halfH))
                context.stroke(tl, with: .color(color), lineWidth: lineWidth)

                // Top-right
                var tr = Path()
                tr.move(to: CGPoint(x: cx + halfW - arm, y: cy - halfH))
                tr.addLine(to: CGPoint(x: cx + halfW, y: cy - halfH))
                tr.addLine(to: CGPoint(x: cx + halfW, y: cy - halfH + arm))
                context.stroke(tr, with: .color(color), lineWidth: lineWidth)

                // Bottom-left
                var bl = Path()
                bl.move(to: CGPoint(x: cx - halfW, y: cy + halfH - arm))
                bl.addLine(to: CGPoint(x: cx - halfW, y: cy + halfH))
                bl.addLine(to: CGPoint(x: cx - halfW + arm, y: cy + halfH))
                context.stroke(bl, with: .color(color), lineWidth: lineWidth)

                // Bottom-right
                var br = Path()
                br.move(to: CGPoint(x: cx + halfW - arm, y: cy + halfH))
                br.addLine(to: CGPoint(x: cx + halfW, y: cy + halfH))
                br.addLine(to: CGPoint(x: cx + halfW, y: cy + halfH - arm))
                context.stroke(br, with: .color(color), lineWidth: lineWidth)
            }
        }
        .allowsHitTesting(false)
    }

    // MARK: - Reveal Mask

    /// Gradient mask that reveals content as the scan beam passes.
    private func revealMask(totalHeight: CGFloat) -> some View {
        GeometryReader { _ in
            let beamY = scanProgress * totalHeight

            VStack(spacing: 0) {
                // Fully revealed
                Color.white
                    .frame(height: max(beamY - 8, 0))

                // Soft edge
                LinearGradient(
                    colors: [Color.white, Color.white.opacity(0.2)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 36)

                // Not yet revealed
                Color.white.opacity(0.08)
            }
            .frame(maxHeight: .infinity, alignment: .top)
        }
    }

    // MARK: - Animation Loops

    private func startScanLoop() {
        scanProgress = -0.10

        withAnimation(
            .easeInOut(duration: scanDuration)
                .repeatForever(autoreverses: false)
        ) {
            scanProgress = 1.12
        }
    }

    private func startShimmerLoop() {
        withAnimation(
            .linear(duration: 3.0)
                .repeatForever(autoreverses: false)
        ) {
            shimmerPhase = 1.5
        }
    }

    private func startParticleConverge() {
        withAnimation(
            .easeOut(duration: particleConverge)
                .repeatForever(autoreverses: true)
        ) {
            particleSpread = 0.0
        }
    }

    // MARK: - Constants

    private enum UIConstants {
        /// Extra horizontal room so the beam extends past the skeleton edges.
        static let horizontalInset: CGFloat = 25
    }
}

// MARK: - Particle Model

private struct Particle {
    let targetX: CGFloat
    let targetY: CGFloat
    let offsetX: CGFloat
    let offsetY: CGFloat
    let size: CGFloat
    let alpha: Double
    let color: Color
}

/// Generates a deterministic set of particles. Uses a simple LCG so the
/// layout is stable across frames (Canvas redraws frequently).
private func generateParticles(count: Int, width: CGFloat, height: CGFloat) -> [Particle] {
    var seed: UInt64 = 0xDEAD_BEEF
    func nextRandom() -> CGFloat {
        seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return CGFloat((seed >> 33) & 0x7FFF_FFFF) / CGFloat(0x7FFF_FFFF)
    }

    let colors: [Color] = [.accentColor, .cyan, .blue, .purple, .indigo]
    var particles: [Particle] = []
    particles.reserveCapacity(count)

    for _ in 0..<count {
        let tx = nextRandom() * width
        let ty = nextRandom() * height * 0.75
        let ox = (nextRandom() - 0.5) * width * 0.8
        let oy = (nextRandom() - 0.5) * height * 0.4
        let sz = 1.5 + nextRandom() * 2.5
        let a = 0.3 + Double(nextRandom()) * 0.5
        let c = colors[Int(nextRandom() * CGFloat(colors.count)) % colors.count]
        particles.append(
            Particle(targetX: tx, targetY: ty, offsetX: ox, offsetY: oy, size: sz, alpha: a, color: c)
        )
    }
    return particles
}

// MARK: - Preview

#Preview {
    DocumentScanAnimation()
        .frame(width: 520, height: 520)
        .background(.background)
}
