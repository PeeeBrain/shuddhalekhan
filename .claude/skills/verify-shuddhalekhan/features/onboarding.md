# Onboarding

A fresh install opens Settings on a three-step `Set up Dictation` screen: install the recommended local speech model, check the microphone, then complete one real Dictation. An escape hatch leads to the full Settings for users who bring their own provider.

## Sub-features

- `onboarding-shown` shows Settings on onboarding at first launch, because `onboarding.status` is `pending`.
- `onboarding-model` covers Step 1's `Download model` for the model and size the page names.
- `onboarding-mic` covers Step 2's `Start microphone check`, which stays disabled until the model is ready.
- `onboarding-advanced` covers `Configure an advanced provider`, which opens the full Settings with its sidebar.

## How to get to it (user POV)

- Launch the app with no existing config. Settings opens by itself.

## Driving it with sl.ts

Preconditions:

- Linux. Run `SL_FRESH_CONFIG=1 bun $S launch`. The real config has finished onboarding, so this feature needs a fresh one.
- `doctor` reports `config: fresh`.

- **Shown.** Run `bun $S wait settings "Set up Dictation"`, then `bun $S shot settings onboarding`. The screenshot shows Steps 1–3 with `Download model` enabled and `Start microphone check` dimmed.
- **Gated mic.** Run `bun $S eval settings "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Start microphone check').disabled"`. It prints `true`.
- **Advanced.** Run `bun $S click settings "Configure an advanced provider"`, then `bun $S wait settings "Readiness"`. The settings sidebar is visible, and Home's `Readiness` shows the speech engine as not ready, because nothing is installed yet.

## Gotchas

- Windows can't run this without an app change (see SKILL.md). Report it as not exercised there.
- `Download model` fetches the size Step 1 shows into the throwaway config, and `stop` deletes it. Don't click it unless the change is about model install.
- On a fresh config, `app.log` shows `Managed Local warmup failed: … Install CPU files`. That's expected.
- Step 3 names the shortcut to press. Read it from the page; it is the fresh config's binding, not the maintainer's. It needs a human. See [dictation](./dictation.md).
