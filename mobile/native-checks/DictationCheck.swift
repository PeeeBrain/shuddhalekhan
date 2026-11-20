import Foundation

@main
struct DictationCheck {
  @MainActor static func main() throws {
    let rows: [(String, DictationStyle, String, String)] = [
      ("um hello there. how are you", .polished, "en", "Hello there. How are you."),
      ("“hello world”", .polished, "en", "“Hello world.”"),
      ("hello there.", .casual, "en", "hello there"),
      ("Contact Acme Inc.", .casual, "en", "Contact Acme Inc."),
      ("meeting new paragraph bullet call Ada new line bring notes", .notes, "en", "meeting\n\n• call Ada\nbring notes"),
      ("um, keep my words", .verbatim, "en", "um, keep my words"),
      ("旧 字。", .polished, "zh", "旧 字。"),
      ("um nochmals", .polished, "de", "um nochmals"),
      ("  existing text  ", .legacy, "", "  existing text  "),
      ("", .polished, "en", ""),
    ]
    for (raw, style, language, expected) in rows {
      let text = DictationFormatter.style(raw, as: style, language: language)
      precondition(text == expected, "Unexpected \(style) result: \(text.debugDescription)")
      precondition(DictationFormatter.style(text, as: style, language: language) == text)
    }

    let terms = ["PyTorch", "Open AI", "Open AI Labs", "O’Connor", "Élan"]
    precondition(DictationVocabulary.validated(terms) == terms)
    precondition(DictationVocabulary.validated(["Open AI", "open-ai"]) == nil)
    precondition(DictationVocabulary.validated(["!!!"]) == nil)
    precondition(DictationVocabulary.validated([String(repeating: "a", count: 65)]) == nil)
    precondition(DictationVocabulary.validated((0...100).map { "Term \($0)" }) == nil)
    let vocabulary = DictationVocabulary(terms)
    let text = vocabulary.apply(to: "pytorch, pytorch’s; pytorcher. open-ai LABS, open ai and o'connor. E\u{301}LAN!")
    precondition(text == "PyTorch, PyTorch’s; pytorcher. Open AI Labs, Open AI and O’Connor. Élan!")
    precondition(vocabulary.apply(to: text) == text)
    precondition(vocabulary.apply(to: DictationFormatter.style("pytorch", as: .polished, language: "en")) == "PyTorch.")

    precondition(KeyboardInsertion.text("world", before: "hello", after: "!") == " world")
    precondition(KeyboardInsertion.text("hello", before: "(", after: "world") == "hello ")
    precondition(KeyboardInsertion.text("…", before: "emoji 👨‍👩‍👧", after: nil) == "…")
    precondition(KeyboardInsertion.text("世界", before: "你好", after: "！") == "世界")
    precondition(KeyboardInsertion.text("world", before: nil, after: nil) == "world")
    precondition(KeyboardInsertion.confirmsInsertion(" world", before: "hello", resultingBefore: "hello world"))
    precondition(KeyboardInsertion.confirmsInsertion(" world", before: "hello", resultingBefore: "o world"))
    precondition(!KeyboardInsertion.confirmsInsertion(" world", before: "hello world", resultingBefore: "hello world"))
    precondition(!KeyboardInsertion.confirmsInsertion(" world", before: "hello", resultingBefore: "changed world"))
    let id = UUID()
    let now = Date()
    let utterance = KeyboardInsertion.Undo(document: id, before: "Hey 👨‍👩‍👧", after: ".", inserted: " 👨‍👩‍👧",
      expires: now.addingTimeInterval(12))
    precondition(utterance.matches(document: id, before: "Hey 👨‍👩‍👧", after: ".", selected: nil, now: now))
    precondition(!utterance.matches(document: id, before: " edited Hey 👨‍👩‍👧", after: ".", selected: nil, now: now))
    precondition(!utterance.matches(document: id, before: nil, after: nil, selected: nil, now: now))
    precondition(!utterance.matches(document: UUID(), before: "Hey 👨‍👩‍👧", after: ".", selected: nil, now: now))
    precondition(!utterance.matches(document: id, before: "Hey 👨‍👩‍👧", after: ".", selected: nil, now: now.addingTimeInterval(12)))

    precondition(DictationCleanupGuard.accepts("Pay Ada 12 dollars.", replacing: "um pay Ada 12 dollars") == false)
    precondition(DictationCleanupGuard.accepts("pay Ada 12 dollars.", replacing: "um pay Ada 12 dollars"))
    precondition(!DictationCleanupGuard.accepts("pay Ada 120 dollars", replacing: "pay Ada 12 dollars"))
    precondition(!DictationCleanupGuard.accepts("take 1 2 tablet", replacing: "take 1/2 tablet"))
    precondition(!DictationCleanupGuard.accepts("take 1 2 tablet", replacing: "take 1⁄2 tablet"))
    precondition(DictationCleanupGuard.accepts("take 1/2 tablet.", replacing: "take 1/2 tablet"))
    precondition(!DictationCleanupGuard.accepts("email Ada", replacing: "do not email Ada"))
    precondition(!DictationCleanupGuard.accepts("send this to someone else", replacing: "send this to Ada"))

    precondition(!ControlDictationLaunch.consume())
    ControlDictationLaunch.request()
    precondition(ControlDictationLaunch.consume())
    precondition(!ControlDictationLaunch.consume(), "A single Control Center tap must not replay.")

    let microphone = MicrophoneOwnership()
    let keyboard = try microphone.claim(.keyboard)
    precondition((try? microphone.claim(.foreground)) == nil)
    precondition((try? microphone.claim(.system)) == nil)
    microphone.release(keyboard)
    let system = try microphone.claim(.system)
    microphone.release(keyboard)
    precondition(microphone.owner == .system)
    microphone.release(system)
    let foreground = try microphone.claim(.foreground)
    microphone.release(foreground)
    precondition(microphone.owner == nil)
  }
}
