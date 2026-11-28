import Foundation

@main
struct DictationUndoCheck {
  static func main() {
    let field = UUID()
    // " hello." dictated at the end of "Say hello. Other words,".
    guard let undo = DictationUndo(text: " hello.", document: field, before: "Say hello. Other words,", after: "",
      resultingDocument: field, resultingBefore: "Say hello. Other words, hello.", resultingAfter: "")
    else { fatalError("not armed") }
    precondition(undo.matches(document: field, before: "Say hello. Other words, hello.", after: "", selected: nil))
    // The cursor moved after the earlier " hello.", even in a host that shows only that much: never that copy.
    precondition(!undo.matches(document: field, before: "Say hello.", after: " Other words, hello.", selected: nil))
    precondition(!undo.matches(document: field, before: "Say hello.", after: "", selected: nil))
    // Text typed after it, or a selection, ends Undo.
    precondition(!undo.matches(document: field, before: "Say hello. Other words, hello. Hi", after: "", selected: nil))
    precondition(!undo.matches(document: field, before: "Say hello. Other words, hello.", after: "", selected: "hello."))
    // Another field, or a host that stops showing either side, confirms nothing.
    precondition(!undo.matches(document: UUID(), before: "Say hello. Other words, hello.", after: "", selected: nil))
    precondition(!undo.matches(document: field, before: "Say hello. Other words, hello.", after: nil, selected: nil))
    precondition(!undo.matches(document: field, before: nil, after: "", selected: nil))
    // A host that shows a window of the field still confirms the insert.
    precondition(DictationUndo(text: " world", document: field, before: "hello", after: "!",
      resultingDocument: field, resultingBefore: "o world", resultingAfter: "!") != nil)
    // The host rejected the insert (a full field), something else changed, the field changed,
    // or the host withheld a side: no Undo to offer.
    precondition(DictationUndo(text: " hello.", document: field, before: "hello.", after: "",
      resultingDocument: field, resultingBefore: "hello.", resultingAfter: "") == nil)
    precondition(DictationUndo(text: " world", document: field, before: "hello", after: "",
      resultingDocument: field, resultingBefore: "changed world", resultingAfter: "") == nil)
    precondition(DictationUndo(text: " world", document: field, before: "hello", after: "",
      resultingDocument: UUID(), resultingBefore: "hello world", resultingAfter: "") == nil)
    precondition(DictationUndo(text: " world", document: nil, before: "hello", after: "",
      resultingDocument: nil, resultingBefore: "hello world", resultingAfter: "") == nil)
    precondition(DictationUndo(text: " world", document: field, before: "hello", after: nil,
      resultingDocument: field, resultingBefore: "hello world", resultingAfter: nil) == nil)
  }
}
