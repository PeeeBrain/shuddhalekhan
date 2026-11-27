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
    // The cursor sits after an earlier copy at the start of the field: Undo takes back the dictation, not the copy.
    let again = DictationUndo(text: " See you soon.", before: "See you soon. Bye.", after: "")
    precondition(again.plan(before: "See you soon.", after: " Bye. See you soon.", selected: nil)
      == DictationUndo.Plan(toEnd: 19, delete: 14, back: -5))
    // An earlier copy whose shown context matches the end of what preceded the dictation is not it either.
    let short = DictationUndo(text: " hello.", before: "A hello. B A", after: "")
    precondition(short.plan(before: "A hello.", after: " B A hello.", selected: nil) == nil)
  }
}
