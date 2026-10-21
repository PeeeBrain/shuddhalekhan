---
name: Shuddhalekhan
description: Quiet, precise voice dictation and voice-to-agent for Windows. Bring your own models.
colors:
  slate-blue: "#719ed6"
  vermilion: "#e08652"
  lampblack-canvas: "#0e0d0b"
  lampblack: "#12100f"
  soot-card: "#191715"
  ash-raised: "#262422"
  ash-muted: "#312e2b"
  hairline: "#393632"
  parchment: "#f1efe9"
  faded-ink: "#9c958b"
  on-signal: "#141210"
  seal-red: "#d1616a"
  verdigris: "#5eba8f"
  ochre: "#daa64e"
typography:
  headline:
    fontFamily: "Segoe UI Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Segoe UI Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.375
  body:
    fontFamily: "Segoe UI Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.43
  body-compact:
    fontFamily: "Segoe UI Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.54
  label:
    fontFamily: "Segoe UI Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.33
  caption:
    fontFamily: "Segoe UI Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.45
    fontFeature: "tnum"
rounded:
  pill-agent-glyph: "3px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  pill-dictation: "14px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  page: "40px"
components:
  button-primary:
    backgroundColor: "{colors.slate-blue}"
    textColor: "{colors.on-signal}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.ash-raised}"
    textColor: "{colors.parchment}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.parchment}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-destructive:
    backgroundColor: "{colors.seal-red}"
    textColor: "{colors.parchment}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.parchment}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  settings-card:
    backgroundColor: "{colors.soot-card}"
    rounded: "{rounded.xl}"
    padding: "0 16px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.faded-ink}"
    typography: "{typography.body-compact}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  nav-item-active:
    backgroundColor: "{colors.ash-raised}"
    textColor: "{colors.parchment}"
  recording-pill-dictation:
    backgroundColor: "{colors.soot-card}"
    textColor: "{colors.slate-blue}"
    rounded: "{rounded.pill-dictation}"
    height: "40px"
    width: "160px"
  recording-pill-agent:
    textColor: "{colors.vermilion}"
    rounded: "{rounded.sm}"
    height: "40px"
    width: "160px"
---

# Design System: Shuddhalekhan

## 1. Overview

**Creative North Star: "Lampblack & Cinnabar"**

Shuddhalekhan (शुद्धलेखन, "pure writing") borrows from the oldest writing kit there is: lampblack ink, parchment, and a seal pressed in red. Surfaces are warm ink, never cool or blue-black. Text is parchment, never pure white. Color appears only where it carries meaning: Slate Blue marks Dictation, Vermilion marks Agent Mode, and the status hues (Seal Red, Verdigris, Ochre) mark outcomes. Everything else is ink.

The system is a guest in someone else's window. The recording pill and toasts float over the user's real work, so they are small, quiet, and quick to leave. Settings is a native-feeling Windows utility: Segoe UI Variable, a left nav, dense rows, and no branding noise. It should feel Apple-like in restraint (clear hierarchy, physical motion that means something, nothing ornamental) while staying true to the Windows platform it runs on.

It rejects generic AI-SaaS (purple gradients, glassmorphism, sparkle icons, chatbot framing), gamer/RGB overlays (neon glows, constant animation, GPU-heavy effects), and enterprise settings (dense forms, nested cards, jargon-heavy labels).

**Key Characteristics:**
- Dark, warm, low-chroma ink surfaces layered by tone, not shadow.
- Two signal hues with fixed meanings; no decorative color.
- One system font family at a tight, dense product scale.
- Motion is short (100–180ms), ease-out, state-only, and disabled under `prefers-reduced-motion`.
- Dictation and Agent Mode differ by shape and glyph, not color alone.
- Idle surfaces never repaint.

## 2. Colors

A restrained palette: warm lampblack neutrals plus two signal pigments, each with exactly one job.

### Primary
- **Slate Blue** (#719ed6): Dictation's color, and the app's interactive accent: primary buttons, checked switches, focus rings, the active nav icon, the Dictation recording pill's bars and glyph tint. Text on it uses On-Signal ink.

### Secondary
- **Vermilion** (#e08652): Agent Mode only. The Agent recording pill, agent toasts and approval cards (as a 5–7% tint mixed into Soot Card, with a 35–45% Vermilion hairline border), and agent status text. Never used for Dictation, generic emphasis, or errors.

### Neutral
- **Lampblack Canvas** (#0e0d0b): the deepest layer; Settings sidebar.
- **Lampblack** (#12100f): window background behind content.
- **Soot Card** (#191715): cards, popovers, toasts, the recording pill body.
- **Ash Raised** (#262422): secondary buttons, active nav item, hover fills.
- **Ash Muted** (#312e2b): muted fills, kbd chips, low-emphasis panels (usually at 20–70% alpha).
- **Hairline** (#393632): borders and input strokes, often at 60–80% alpha.
- **Parchment** (#f1efe9): primary text (15.5:1 on Soot Card).
- **Faded Ink** (#9c958b): secondary text, descriptions, inactive nav (6.0:1 on Soot Card).
- **On-Signal** (#141210): text on Slate Blue, Verdigris, Ochre, and Vermilion fills.

### Status
- **Seal Red** (#d1616a): destructive actions and failures (4.8:1 on Soot Card; the floor, do not darken).
- **Verdigris** (#5eba8f): success, connected, completed.
- **Ochre** (#daa64e): warnings and the recording time-limit countdown.

### Named Rules
**The One Job Rule.** Each signal hue means one thing. Slate Blue is Dictation and interaction; Vermilion is Agent Mode. If a color appears without its meaning, remove it.

**The Warm Ink Rule.** Every neutral sits at hue 28–42 with saturation ≤12%. A cool gray, blue-black, `#000`, or `#fff` anywhere is a bug.

**Known drift.** `--color-agent` (#d66851) is defined in `app/src/renderer/index.css` but unused; `agent-accent` is the real Vermilion. The `web/` landing page uses these same tokens and system fonts in `web/src/index.css`.

## 3. Typography

**Display Font:** none. Product surfaces have no display type.
**Body Font:** Segoe UI Variable (with Segoe UI, system-ui, sans-serif)
**Label/Mono Font:** same family; `font-mono` only for keyboard-shortcut chips and code.

**Character:** One native family carries everything. It is the voice of Windows itself, which is the point: Shuddhalekhan reads as part of the OS, not a branded app layered on top.

### Hierarchy
- **Headline** (600, 20px, 1.4, -0.025em tracking): Settings section titles. One per view.
- **Title** (600, 15px, 1.375): onboarding and runtime shell headings, card titles.
- **Body** (400, 14px, 1.43): default UI text, buttons, inputs. Prose capped at 65–75ch (`max-w-xl` for descriptions).
- **Body Compact** (400–500, 13px, 1.54): nav items, section descriptions, dense rows.
- **Label** (500, 12px, 1.33): row helper text, metadata, badges. The most-used size in the app.
- **Caption** (500, 11px, tabular figures): nav group headings, the pill's timer, counters. 10px is reserved for kbd chips only.

### Named Rules
**The Native Voice Rule.** No webfonts, no display faces, no uppercase tracking-heavy labels. Hierarchy comes from weight (400 / 500 / 600) and a tight 11–20px scale.

**The Tabular Rule.** Any number that changes while visible (timers, counts, durations) uses tabular figures so it never jitters.

## 4. Elevation

Flat, tonal layering. Depth reads as a step from Lampblack Canvas to Lampblack to Soot Card to Ash Raised, separated by Hairline borders. Shadows are reserved for surfaces that genuinely float above other content: the save toast, confirm dialog, and select popovers. The recording pill is shadowless; its border carries the edge.

### Shadow Vocabulary
- **Floating** (`box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`, Tailwind `shadow-lg`): toasts.
- **Modal** (`shadow-xl`): the confirm dialog only.
- **Popover** (`shadow-md`): select and menu content.

### Named Rules
**The Flat-At-Rest Rule.** Controls and cards in the Settings window carry no meaningful shadow. If you need to separate two things on the same layer, use a tone step or a Hairline, not a shadow. Existing shadcn `shadow-xs`/`shadow-sm` on inputs, switches, and cards is legacy and should not spread.

## 5. Components

### Buttons
Restrained and native; they look like Windows buttons with warmer ink.
- **Shape:** gently rounded (8px).
- **Primary:** Slate Blue fill, On-Signal text, 36px tall, 16px horizontal padding. Sizes: xs 24px, sm 32px, default 36px, lg 40px.
- **Hover / Focus:** hover drops fill to 90% opacity. Focus-visible draws a 3px Slate Blue ring at 50% alpha. Disabled is 50% opacity with no pointer events.
- **Secondary:** Ash Raised fill, Parchment text.
- **Ghost:** transparent; Ash Raised fill on hover. Default for toolbar and row actions.
- **Destructive:** Seal Red. Always paired with explicit copy naming the thing being destroyed.

### Cards / Containers
- **Corner Style:** 12px (`settings-card`).
- **Background:** Soot Card on Lampblack.
- **Shadow Strategy:** none (see Flat-At-Rest).
- **Border:** Hairline at 60% alpha.
- **Internal Padding:** 16px horizontal; rows inside supply their own vertical rhythm. Muted panels (`settings-panel-muted`) use Ash Muted at 20% alpha, 10px radius, 16px × 12px padding. Never nest a card inside a card.

### Inputs / Fields
- **Style:** transparent over a 30% Hairline-alpha fill, Hairline stroke, 8px radius, 36px tall.
- **Focus:** stroke shifts to Slate Blue with a 3px 50%-alpha ring.
- **Error / Disabled:** `aria-invalid` turns the stroke Seal Red with a 20% ring. Disabled is 50% opacity.
- **Switch:** 32 × 18px track; Slate Blue when on, Hairline when off.

### Navigation
- **Style:** a 208px left sidebar on Lampblack Canvas with a Hairline right edge. Items are 32px tall, 6px radius, 13px/500 Faded Ink text with a 16px icon.
- **States:** hover adds an Ash Muted 30% fill and Parchment text. Active uses an Ash Raised fill, Parchment text, and a Slate Blue icon. Focus-visible gets a 2px Slate Blue ring.
- **Groups:** 11px/500 captions at 70% Faded Ink. The System group pins to the bottom.
- **Search:** a nav-item-shaped button with a Hairline border and a `Ctrl K` hint opens the command palette.

### Recording Pill (signature)
The only always-on-top surface that appears during the user's work. It sits 160 × 40px at bottom-center, with a Soot Card body and a Hairline border.
- **Dictation:** 14px radius; a 28px glyph well at 10px radius with a 16% Slate Blue tint; Slate Blue 2px live level bars; an 11px tabular timer in Faded Ink.
- **Agent Mode:** 6px radius (squarer); a glyph well at 3px radius with an 18% Vermilion tint; a 45% Vermilion border; a 7% Vermilion tint mixed into the body. A different glyph. Shape and glyph carry the distinction as much as color.
- **Motion:** enters at scale 0.9 to 1 with fade over 150ms ease-out; exits over 100ms ease-in. Under reduced motion it appears and disappears without animation.
- **Time limit:** bars are replaced by an Ochre countdown line.

### Agent Toasts and Approvals
They inherit the Agent pill's identity: a 6px radius, a Vermilion-tinted Soot Card, and a 35% Vermilion border (`agent-island`). The approval countdown bar is a `scaleX` animation stepped once per second, so a pending approval repaints at 1 Hz, not 60. Thinking dots pulse opacity only.

### Save Toast
Bottom-right of Settings, max 360px, Soot Card with Hairline border, 8px radius, `shadow-lg`. Enters with a 6px rise over 180ms ease-out.

## 6. Do's and Don'ts

### Do:
- **Do** keep every neutral warm (hue 28–42, saturation ≤12%) and text Parchment (#f1efe9), never pure white.
- **Do** reserve Slate Blue (#719ed6) for Dictation and interaction, and Vermilion (#e08652) for Agent Mode only.
- **Do** distinguish Dictation from Agent Mode by shape (14px vs 6px radius) and glyph as well as color.
- **Do** separate layers with tone steps and Hairline (#393632) borders instead of shadows.
- **Do** keep transitions at 100–250ms, ease-out, animating only `opacity` and `transform`, and gate every keyframe behind `prefers-reduced-motion: no-preference`.
- **Do** use tabular figures for every live number.
- **Do** hold all text at WCAG AA or better against its actual surface; Seal Red on Soot Card (4.8:1) is the floor.

### Don't:
- **Don't** look like generic AI-SaaS: no purple gradients, no glassmorphism, no sparkle icons, no chatbot framing.
- **Don't** look like a gamer/RGB overlay: no neon glows, no constant animation, no GPU-heavy effects. A continuously repainting idle surface is a bug.
- **Don't** build enterprise settings: no dense forms, no nested cards, no jargon-heavy labels.
- **Don't** use `backdrop-filter`, blur, or translucency on the pill or toasts; they repaint over the user's app every frame.
- **Don't** use `border-left`/`border-right` greater than 1px as a colored accent on cards, rows, or toasts.
- **Don't** introduce a webfont, display face, or gradient text.
- **Don't** apply Vermilion to anything that is not Agent Mode, or Seal Red to anything that is not a failure or destructive action.
- **Don't** animate width, height, top, left, or any layout property; scale with `transform` instead.
