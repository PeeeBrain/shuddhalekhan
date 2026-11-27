@main
struct DictationUndoCheck {
  static func main() {
    // " hello." dictated at the end of "Say hello. Other words,".
    guard let undo = DictationUndo(text: " hello.", before: "Say hello. Other words,", after: "",
      resultingBefore: "Say hello. Other words, hello.", resultingAfter: "") else { fatalError("not armed") }
    precondition(undo.matches(before: "Say hello. Other words, hello.", after: "", selected: nil))
    // The cursor moved after the earlier " hello.", even in a host that shows only that much: never that copy.
    precondition(!undo.matches(before: "Say hello.", after: " Other words, hello.", selected: nil))
    precondition(!undo.matches(before: "Say hello.", after: "", selected: nil))
    // Text typed after it, or a selection, ends Undo.
    precondition(!undo.matches(before: "Say hello. Other words, hello. Hi", after: "", selected: nil))
    precondition(!undo.matches(before: "Say hello. Other words, hello.", after: "", selected: "hello."))
    // A host that shows a window of the field still confirms the insert.
    precondition(DictationUndo(text: " world", before: "hello", after: "!", resultingBefore: "o world",
      resultingAfter: "!") != nil)
    // The host rejected the insert (a full field), or something else changed: no Undo to offer.
    precondition(DictationUndo(text: " hello.", before: "hello.", after: "", resultingBefore: "hello.",
      resultingAfter: "") == nil)
    precondition(DictationUndo(text: " world", before: "hello", after: "", resultingBefore: "changed world",
      resultingAfter: "") == nil)
  }
}
