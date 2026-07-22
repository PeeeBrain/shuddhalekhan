# Recording Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a deep Recording Session module that owns the complete audio-capture lifecycle while leaving dictation vs. Agent routing in the Electron main orchestrator.

**Architecture:** Add `src/main/recording-session.ts` with `begin(intent)`, `end()`, `cancel()`, and `isActive()`. The module owns hidden audio window readiness, queued starts, recording pill visibility, audio data completion, empty WAV skipping, transcription, and native keyboard hook lifecycle. `src/main/index.ts` keeps only result routing: dictation text is pasted, Agent text starts the sidecar.

**Tech Stack:** Electron main process, Bun tests, TypeScript, existing `koffi` keyboard hook and renderer audio window IPC.

---

### Task 1: Recording Session Module

**Files:**
- Create: `src/main/recording-session.ts`
- Create: `src/main/__tests__/recording-session.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:
- `begin('dictation')` creates the audio window, sends `audio:start-recording` immediately when ready, and shows the pill.
- `begin('agent')` queues start until `markAudioWindowReady()` when the hidden window is loading.
- `end()` hides the pill, sends `audio:stop-recording`, and resolves with `{ text, intent }` after `complete(audioData)`.
- empty WAV payloads resolve to `null` without transcription.
- `cancel()` hides the pill, stops the audio window, and clears active state.

- [ ] **Step 2: Run targeted test to verify RED**

Run: `bun test src/main/__tests__/recording-session.test.ts`
Expected: FAIL because `src/main/recording-session.ts` does not exist.

- [ ] **Step 3: Implement minimal module**

Create a dependency-injected `RecordingSession` class plus a production `createRecordingSession()` factory. Keep `transcribe` inside the module; keep clipboard and Agent sidecar outside.

- [ ] **Step 4: Run targeted test to verify GREEN**

Run: `bun test src/main/__tests__/recording-session.test.ts`
Expected: PASS.

### Task 2: Main Orchestrator Refactor

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/__tests__/index.test.ts`

- [ ] **Step 1: Update main-process tests**

Mock `createRecordingSession()` and assert `index.ts` delegates recording lifecycle to the session. Keep tests for dictation clipboard paste and Agent sidecar routing by resolving `session.end()` with `{ text, intent }`.

- [ ] **Step 2: Run targeted test to verify RED**

Run: `bun test src/main/__tests__/index.test.ts`
Expected: FAIL until `index.ts` uses the new session.

- [ ] **Step 3: Refactor `index.ts`**

Remove local `isRecording`, `isAudioWindowReady`, `pendingStartRecording`, and `activeRecordingIntent`. Wire IPC and keyboard callbacks to `recordingSession.begin()`, `recordingSession.end().then(routeRecordingResult)`, `recordingSession.cancel()`, `recordingSession.markAudioWindowReady()`, `recordingSession.complete()`, and `recordingSession.stopKeyboardHook()`.

- [ ] **Step 4: Run targeted test to verify GREEN**

Run: `bun test src/main/__tests__/index.test.ts`
Expected: PASS.

### Task 3: Verification

**Files:**
- Modify if needed: `CONTEXT.md`

- [ ] **Step 1: Run full checks**

Run:
- `bun run lint`
- `bun run typecheck`
- `bun test`

- [ ] **Step 2: Review diffs**

Run: `git diff --check` and `git diff --stat`.

