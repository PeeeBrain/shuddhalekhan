import UIKit

/// The desktop pill's lucide Mic and Bot glyphs, so both platforms share one mark per mode.
@MainActor
enum VoiceMarks {
  /// DESIGN.md tokens: Slate Blue is Dictation only, Vermilion is Agent only.
  static let blue = UIColor(red: 0x71 / 255, green: 0x9E / 255, blue: 0xD6 / 255, alpha: 1)
  static let vermilion = UIColor(red: 0xE0 / 255, green: 0x86 / 255, blue: 0x52 / 255, alpha: 1)

  static let mic = draw { path in
    path.append(UIBezierPath(roundedRect: CGRect(x: 9, y: 2, width: 6, height: 13), cornerRadius: 3))
    path.move(to: CGPoint(x: 19, y: 10))
    path.addLine(to: CGPoint(x: 19, y: 12))
    path.addArc(withCenter: CGPoint(x: 12, y: 12), radius: 7, startAngle: 0, endAngle: .pi, clockwise: true)
    path.addLine(to: CGPoint(x: 5, y: 10))
    path.move(to: CGPoint(x: 12, y: 19))
    path.addLine(to: CGPoint(x: 12, y: 22))
  }

  static let bot = draw { path in
    path.move(to: CGPoint(x: 12, y: 8))
    path.addLine(to: CGPoint(x: 12, y: 4))
    path.addLine(to: CGPoint(x: 8, y: 4))
    path.append(UIBezierPath(roundedRect: CGRect(x: 4, y: 8, width: 16, height: 12), cornerRadius: 2))
    for (from, to) in [((2, 14), (4, 14)), ((20, 14), (22, 14)), ((15, 13), (15, 15)), ((9, 13), (9, 15))] {
      path.move(to: CGPoint(x: from.0, y: from.1))
      path.addLine(to: CGPoint(x: to.0, y: to.1))
    }
  }

  /// Strokes a 24-point lucide path at 22 points as a template image.
  private static func draw(_ build: (UIBezierPath) -> Void) -> UIImage {
    let size: CGFloat = 22
    let path = UIBezierPath()
    build(path)
    path.apply(CGAffineTransform(scaleX: size / 24, y: size / 24))
    path.lineWidth = 2 * size / 24
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    return UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { _ in
      UIColor.black.setStroke()
      path.stroke()
    }.withRenderingMode(.alwaysTemplate)
  }
}

/// Live input level as a dot field, the desktop recording pill's theme: two strands braid through a 25 × 5 grid
/// and fold onto the resting centre line at silence. Round dots for Dictate, square for Agent. Driven only by real
/// levels from the app while recording (each push advances the braid); between pushes nothing animates.
/// The field math mirrors `voiceField` in app/src/renderer/recording-popup-math.ts.
final class LevelDots: UIView {
  private static let columns = 25
  private static let rows = 5
  private static let pitch: CGFloat = 5
  private static let dot: CGFloat = 3
  private static let baseAlpha: Float = 0.16
  private static let lineRest: CGFloat = 0.45
  private var level: CGFloat = 0
  private var phase: CGFloat = 0
  private let dots: [CALayer] = (0..<columns * rows).map { _ in CALayer() }

  var color = UIColor.white { didSet { for dot in dots { dot.backgroundColor = color.cgColor } } }
  var square = false { didSet { for dot in dots { dot.cornerRadius = square ? 0 : Self.dot / 2 } } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    for dot in dots {
      dot.cornerRadius = Self.dot / 2
      layer.addSublayer(dot)
    }
    isAccessibilityElement = false
    isUserInteractionEnabled = false
    paint(animated: false)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  override var intrinsicContentSize: CGSize {
    CGSize(width: CGFloat(Self.columns - 1) * Self.pitch + Self.dot, height: CGFloat(Self.rows - 1) * Self.pitch + Self.dot)
  }

  /// One reading, about every 1/15 s. The level is already dB-scaled 0–1, so unlike desktop it needs no lift.
  /// Under Reduce Motion the braid holds its shape and only its height follows the voice.
  func push(_ next: CGFloat) {
    level = min(max(next, 0), 1)
    if !UIAccessibility.isReduceMotionEnabled { phase += (2 + 6 * level) / 15 }
    paint(animated: true)
  }

  func settle() {
    guard level > 0 else { return }
    level = 0
    paint(animated: true)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let size = intrinsicContentSize
    let origin = CGPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2)
    for (index, dot) in dots.enumerated() {
      let x = origin.x + CGFloat(index % Self.columns) * Self.pitch
      let y = origin.y + CGFloat(index / Self.columns) * Self.pitch
      dot.frame = CGRect(x: x, y: y, width: Self.dot, height: Self.dot)
    }
    CATransaction.commit()
  }

  private func paint(animated: Bool) {
    CATransaction.begin()
    CATransaction.setDisableActions(!animated || UIAccessibility.isReduceMotionEnabled)
    // About one level interval, so consecutive readings blend instead of stepping.
    CATransaction.setAnimationDuration(0.1)
    CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeOut))
    let mid = CGFloat(Self.rows - 1) / 2
    for column in 0..<Self.columns {
      let u = 2 * CGFloat(column) / CGFloat(Self.columns - 1) - 1
      let env = cos(u * .pi / 2)
      let amplitude = level * mid * env
      let a = amplitude * sin(phase + 2.4 * u)
      let b = amplitude * sin(phase * 0.77 - 3.1 * u + 2)
      let strength = Self.lineRest + (1 - Self.lineRest) * max(env, level)
      for row in 0..<Self.rows {
        let y = CGFloat(row) - mid
        let lit = max(0, 1 - abs(y - a), 1 - abs(y - b)) * strength
        dots[row * Self.columns + column].opacity = Self.baseAlpha + (1 - Self.baseAlpha) * Float(lit)
      }
    }
    CATransaction.commit()
  }
}
