@main
struct DictationUndoCheck {
  static func main() {
    // " hello." dictated at the end of "Say hello. Other words,".
    let undo = DictationUndo(text: " hello.", before: "Say hello. Other words,", after: "")
    precondition(undo.plan(before: "Say hello. Other words, hello.", after: "", selected: nil)
      == DictationUndo.Plan(toEnd: 0, delete: 7, back: 0))
    // The cursor moved to just after the earlier " hello.": that copy must never be deleted.
    precondition(undo.plan(before: "Say hello.", after: " Other words, hello.", selected: nil) == nil)
    // A host showing only the cursor's sentence still finds it.
    precondition(undo.plan(before: "hello.", after: "", selected: nil) == DictationUndo.Plan(toEnd: 0, delete: 7, back: 0))
  }
}
