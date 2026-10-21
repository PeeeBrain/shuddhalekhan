# Product

## Register

product

## Users

People who spend their day in other apps (editors, browsers, chat, terminals) on Windows and want to speak instead of type. They bring their own API keys for speech-to-text and LLM providers. Many are tinkerers who will fork and reconfigure the app. Their attention is elsewhere: Shuddhalekhan is glanced at, not stared at. The recording pill, toasts, and approval prompts appear over someone else's work; Settings is visited occasionally to configure providers, shortcuts, MCP servers, and tool policies.

## Product Purpose

An open, bring-your-own-subscription alternative to Wispr Flow. Two separate intents:

- **Dictation**: speak, and clean text lands in the focused app.
- **Agent Mode**: speak a one-off command to a local agent harness with MCP tools; watch progress in toasts, approve sensitive tools inline.

Success is invisibility: a hotkey that never misses, a pill that never sticks, a toast that never lies, a paste that never clobbers the clipboard, and no measurable GPU or CPU cost while idle.

## Brand Personality

**Quiet, precise, open.**

- Quiet: stays out of the way of the user's real work. Small surfaces, few words, no decoration competing with the focused app.
- Precise: says exactly what happened. Status copy is literal and honest; states are unambiguous (recording, transcribing, waiting for approval, done, failed).
- Open: no lock-in, no upsell, no mystery. Configuration is legible and forkable.

Feel: Apple-like. It should read as a native part of the OS, closer to macOS/Windows system UI than to a branded SaaS product. Restraint, clarity, and physical, purposeful motion over spectacle.

## Anti-references

- **Generic AI-SaaS**: purple gradients, glassmorphism as decoration, sparkle icons, chatbot framing.
- **Gamer/RGB overlays**: neon glows, constant animation, GPU-heavy effects. Continuously repainting animation is a bug, not a style.
- **Enterprise settings**: dense forms, nested cards, jargon-heavy labels.

## Design Principles

1. **Guest in someone else's window.** Every overlay is an interruption; earn it with minimal footprint and fast exit.
2. **Honest state over reassuring state.** Show what is actually happening. Never imply success before it happened.
3. **Native before novel.** Defer to OS conventions for type, controls, and behavior; add identity only where it carries meaning (Dictation vs Agent Mode).
4. **Performance is a design property.** A beautiful effect that spikes the GPU is a defect.
5. **Legible configuration.** Settings explain themselves plainly so users can confidently bring their own providers and tools.

## Accessibility & Inclusion

- WCAG 2.2 AA contrast for all text and meaningful UI.
- Respect `prefers-reduced-motion`; motion must never be the only signal of state.
- Dictation vs Agent Mode must be distinguishable without color alone (label, icon, or shape).
- Full keyboard operability in Settings and approval prompts.
