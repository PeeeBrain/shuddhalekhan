# Typing keyboard: adapted from Hex

The typing half of Shuddhalekhan's iOS keyboard extension is adapted from the iPhone keyboard in
[Hex](https://github.com/anomalyco/hex) (`ios/`, commit `f38e9fc469927ea6c742f8856004f5734ce67665`),
© 2026 Christopher Langton, under the MIT License in `Licenses/Hex-LICENSE.txt`. Most of the code in this
`Typing/` folder is Hex's work: the keys, suggestion strip, autocorrect, swipe typing, emoji panel and selection
tools. Each file starts with a line naming the Hex file it came from.

Only this keyboard comes from Hex. Shuddhalekhan's desktop app, the rest of the iOS app, speech recognition,
keyboard sessions and Agent Mode are Shuddhalekhan's own and borrow nothing from it.

Shuddhalekhan renamed the files and types for this codebase, and replaced Hex's dictation routes, settings,
App Group and branding: the Dictation and Agent keys in the strip drive Shuddhalekhan's keyboard session
(`../KeyboardViewController.swift`). `../ContainingAppOpener.swift`, which opens the app from the keyboard, is Hex's too. Every keyboard setting is fixed at Hex's default, the language is always
Automatic, and only the English typing model ships.

## Bundled data

- **`Resources/en.typingmodel`:** word and word-pair frequencies from the Google Books Ngram Viewer data, version 3
  (2020), by Google, licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Words are checked
  against SCOWL and VarCon by Kevin Atkinson (<http://wordlist.aspell.net/>), Copyright 2000-2018 by Kevin Atkinson.
  Permission to use, copy, modify, distribute and sell these word lists, the associated scripts, the output created
  from the scripts, and its documentation for any purpose is hereby granted without fee, provided that the above
  copyright notice appears in all copies and that both that copyright notice and this permission notice appear in
  supporting documentation. Kevin Atkinson makes no representations about the suitability of this array for any
  purpose. It is provided "as is" without express or implied warranty.
  SCOWL's inflections come from WordNet 1.6, Copyright 1997 by Princeton University. All rights reserved. THIS
  SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND PRINCETON UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS
  OR IMPLIED. BY WAY OF EXAMPLE, BUT NOT LIMITATION, PRINCETON UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES OF
  MERCHANTABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE LICENSED SOFTWARE, DATABASE OR
  DOCUMENTATION WILL NOT INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS OR OTHER RIGHTS. The name of
  Princeton University or Princeton may not be used in advertising or publicity pertaining to distribution of the
  software and/or database. SCOWL's other sources (12Dicts, Moby Words II, and Brian Kelk's UK English Wordlist) are
  in the public domain.
- **`Resources/never-suggest.tsv`:** the suggestion filter uses the
  [List of Dirty, Naughty, Obscene, and Otherwise Bad Words](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/tree/5faf2ba42d7b1c0977169ec3611df25a3c08eb13),
  © 2012–2020 Shutterstock, Inc., and contributors, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Hex lowercased and classified the entries, omitted
  ordinary, medical and search-only terms, and added common slurs, inflections and spelling variants.
- **`Resources/emoji-index-en.txt`:** built from Unicode CLDR and emoji data, under the Unicode License V3
  in `Licenses/Unicode-LICENSE.txt`.
