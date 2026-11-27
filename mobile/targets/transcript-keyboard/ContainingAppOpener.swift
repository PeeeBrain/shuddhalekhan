// Adapted from Hex's iOS keyboard (https://github.com/anomalyco/hex, MIT), ios/HEXKeyboard/ContainingAppOpener.swift.
// See Typing/NOTICE.md.

import UIKit

/// Opens a URL from the keyboard extension. `extensionContext.open` does nothing in a keyboard, but the
/// extension's responder chain still ends at a `UIApplication` whose `openURL:options:completionHandler:`
/// works; it is unavailable to extensions at compile time, so it is called through the Objective-C runtime
/// (`openURL:` alone is a no-op since iOS 18).
@MainActor
enum ContainingAppOpener {
  private typealias OpenFunction = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void

  @discardableResult
  static func open(_ url: URL, from responder: UIResponder) -> Bool {
    let selector = NSSelectorFromString("openURL:options:completionHandler:")
    guard let application = application(from: responder), application.responds(to: selector) else { return false }
    let open = unsafeBitCast(application.method(for: selector), to: OpenFunction.self)
    open(application, selector, url as NSURL, NSDictionary(), nil)
    return true
  }

  private static func application(from responder: UIResponder) -> UIResponder? {
    var current: UIResponder? = responder
    while let candidate = current {
      if candidate.isKind(of: UIApplication.self) { return candidate }
      current = candidate.next
    }
    return (UIApplication.self as AnyObject).value(forKey: "sharedApplication") as? UIResponder
  }
}
