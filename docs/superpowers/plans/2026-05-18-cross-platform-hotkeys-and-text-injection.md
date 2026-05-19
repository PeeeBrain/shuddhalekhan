# Cross-Platform Hotkeys And Text Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable shortcut actions and resilient text injection semantics without rewriting the recording lifecycle.

**Architecture:** Introduce a narrow shortcut configuration and trigger layer that adapts platform input into the existing `RecordingSession.begin/end/cancel/isActive` verbs. Keep the Windows `koffi` keyboard and paste modules as the active Windows implementation. Add degraded text-injection results so paste failures can leave the transcript on the clipboard and surface a clear failure.

**Tech Stack:** Electron main/preload IPC, React settings UI, TypeScript, Bun tests.

**Scope Guard:** Normalizing Windows away from `koffi` is a future refactor after Electron APIs prove they can preserve Windows behavior. Do not replace `src/main/native/keyboard.ts` or `src/main/native/clipboard.ts` in this plan.

---

### Task 1: Shortcut Domain Types And Config

**Files:**
- Modify: `D:\git_repos\speech-2-text\src\types\ipc.ts`
- Modify: `D:\git_repos\speech-2-text\src\main\config.ts`
- Test: `D:\git_repos\speech-2-text\src\main\__tests__\config.test.ts`

- [ ] **Step 1: Write failing config tests**

Add these assertions to `src/main/__tests__/config.test.ts`:

```ts
it('defaults shortcut actions to suggested Windows bindings when available in config', () => {
  const config = getConfig();

  expect(config.shortcuts).toEqual({
    dictation: {
      action: 'dictation',
      accelerator: 'Control+Meta',
      triggerMode: 'hold',
      status: 'unassigned',
    },
    agent: {
      action: 'agent',
      accelerator: 'Alt+Meta',
      triggerMode: 'hold',
      status: 'unassigned',
    },
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
bun test src/main/__tests__/config.test.ts
```

Expected: FAIL because `AppConfig.shortcuts` does not exist.

- [ ] **Step 3: Add shortcut types**

In `src/types/ipc.ts`, add:

```ts
export type ShortcutAction = RecordingIntent;

export type ShortcutTriggerMode = 'hold' | 'toggle';

export type ShortcutRegistrationStatus =
  | 'ready'
  | 'unassigned'
  | 'conflict'
  | 'reserved'
  | 'needsSetup'
  | 'unsupported';

export interface ShortcutBinding {
  action: ShortcutAction;
  accelerator: string | null;
  triggerMode: ShortcutTriggerMode;
  status: ShortcutRegistrationStatus;
  statusMessage?: string;
}
```

Then add this field to `AppConfig`:

```ts
shortcuts: Record<ShortcutAction, ShortcutBinding>;
```

- [ ] **Step 4: Add config defaults and normalization**

In `src/main/config.ts`, add shortcut defaults to `electron-store` defaults:

```ts
shortcuts: {
  dictation: {
    action: 'dictation',
    accelerator: 'Control+Meta',
    triggerMode: 'hold',
    status: 'unassigned',
  },
  agent: {
    action: 'agent',
    accelerator: 'Alt+Meta',
    triggerMode: 'hold',
    status: 'unassigned',
  },
},
```

In `getConfig()`, include:

```ts
shortcuts: store.get('shortcuts') ?? {
  dictation: {
    action: 'dictation',
    accelerator: 'Control+Meta',
    triggerMode: 'hold',
    status: 'unassigned',
  },
  agent: {
    action: 'agent',
    accelerator: 'Alt+Meta',
    triggerMode: 'hold',
    status: 'unassigned',
  },
},
```

- [ ] **Step 5: Run the config test**

Run:

```powershell
bun test src/main/__tests__/config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/types/ipc.ts src/main/config.ts src/main/__tests__/config.test.ts
git commit -m "feat: add shortcut config model"
```

### Task 2: Shortcut Validation And Trigger Controller

**Files:**
- Create: `D:\git_repos\speech-2-text\src\main\shortcuts\types.ts`
- Create: `D:\git_repos\speech-2-text\src\main\shortcuts\validation.ts`
- Create: `D:\git_repos\speech-2-text\src\main\shortcuts\trigger-controller.ts`
- Test: `D:\git_repos\speech-2-text\src\main\__tests__\shortcut-validation.test.ts`
- Test: `D:\git_repos\speech-2-text\src\main\__tests__\shortcut-trigger-controller.test.ts`

- [ ] **Step 1: Write shortcut validation tests**

Create `src/main/__tests__/shortcut-validation.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import type { ShortcutBinding } from '../../types/ipc';
import { validateShortcutBinding } from '../shortcuts/validation';

const bindings: Record<'dictation' | 'agent', ShortcutBinding> = {
  dictation: { action: 'dictation', accelerator: 'Control+Meta', triggerMode: 'hold', status: 'ready' },
  agent: { action: 'agent', accelerator: null, triggerMode: 'hold', status: 'unassigned' },
};

describe('validateShortcutBinding', () => {
  it('rejects shortcuts already used by another action', () => {
    expect(validateShortcutBinding(
      { action: 'agent', accelerator: 'Control+Meta', triggerMode: 'hold', status: 'unassigned' },
      bindings
    )).toEqual({
      ok: false,
      status: 'conflict',
      message: 'Already used by Dictation.',
    });
  });

  it('accepts available shortcuts', () => {
    expect(validateShortcutBinding(
      { action: 'agent', accelerator: 'Alt+Space', triggerMode: 'toggle', status: 'unassigned' },
      bindings
    )).toEqual({
      ok: true,
      status: 'ready',
    });
  });
});
```

- [ ] **Step 2: Write trigger-controller tests**

Create `src/main/__tests__/shortcut-trigger-controller.test.ts`:

```ts
import { describe, expect, it, mock } from 'bun:test';
import { createShortcutTriggerController } from '../shortcuts/trigger-controller';

describe('createShortcutTriggerController', () => {
  it('maps hold press and release to begin and end', async () => {
    const begin = mock();
    const end = mock(async () => null);
    const controller = createShortcutTriggerController({
      recordingSession: { begin, end, isActive: () => false },
      onResult: mock(),
    });

    controller.handlePress({ action: 'dictation', triggerMode: 'hold' });
    await controller.handleRelease({ action: 'dictation', triggerMode: 'hold' });

    expect(begin).toHaveBeenCalledWith('dictation');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('maps toggle activation to begin when idle and end when active', async () => {
    let active = false;
    const begin = mock(() => { active = true; });
    const end = mock(async () => {
      active = false;
      return { text: 'done', intent: 'dictation' as const };
    });
    const onResult = mock();
    const controller = createShortcutTriggerController({
      recordingSession: { begin, end, isActive: () => active },
      onResult,
    });

    await controller.handleActivation({ action: 'dictation', triggerMode: 'toggle' });
    await controller.handleActivation({ action: 'dictation', triggerMode: 'toggle' });

    expect(begin).toHaveBeenCalledWith('dictation');
    expect(end).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ text: 'done', intent: 'dictation' });
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```powershell
bun test src/main/__tests__/shortcut-validation.test.ts src/main/__tests__/shortcut-trigger-controller.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement shortcut validation**

Create `src/main/shortcuts/types.ts`:

```ts
import type { RecordingIntent, ShortcutTriggerMode } from '../../types/ipc';

export interface ShortcutTriggerEvent {
  action: RecordingIntent;
  triggerMode: ShortcutTriggerMode;
}
```

Create `src/main/shortcuts/validation.ts`:

```ts
import type { ShortcutBinding, ShortcutRegistrationStatus } from '../../types/ipc';

export type ShortcutValidationResult =
  | { ok: true; status: Extract<ShortcutRegistrationStatus, 'ready'> }
  | { ok: false; status: Exclude<ShortcutRegistrationStatus, 'ready'>; message: string };

const actionLabels: Record<string, string> = {
  dictation: 'Dictation',
  agent: 'Agent Mode',
};

export function validateShortcutBinding(
  candidate: ShortcutBinding,
  existing: Record<string, ShortcutBinding>
): ShortcutValidationResult {
  if (!candidate.accelerator) {
    return { ok: false, status: 'unassigned', message: 'Press a shortcut to assign this action.' };
  }

  const conflict = Object.values(existing).find(
    (binding) => binding.action !== candidate.action && binding.accelerator === candidate.accelerator
  );

  if (conflict) {
    return {
      ok: false,
      status: 'conflict',
      message: `Already used by ${actionLabels[conflict.action] ?? conflict.action}.`,
    };
  }

  return { ok: true, status: 'ready' };
}
```

- [ ] **Step 5: Implement trigger controller**

Create `src/main/shortcuts/trigger-controller.ts`:

```ts
import type { RecordingResult } from '../recording-session';
import type { ShortcutTriggerEvent } from './types';

interface RecordingSessionPort {
  begin: (intent: ShortcutTriggerEvent['action']) => void;
  end: () => Promise<RecordingResult | null>;
  isActive: () => boolean;
}

interface ShortcutTriggerControllerDeps {
  recordingSession: RecordingSessionPort;
  onResult: (result: RecordingResult | null) => void | Promise<void>;
}

export function createShortcutTriggerController(deps: ShortcutTriggerControllerDeps) {
  async function finish() {
    const result = await deps.recordingSession.end();
    await deps.onResult(result);
  }

  return {
    handlePress(event: ShortcutTriggerEvent): void {
      if (event.triggerMode !== 'hold') return;
      deps.recordingSession.begin(event.action);
    },
    async handleRelease(event: ShortcutTriggerEvent): Promise<void> {
      if (event.triggerMode !== 'hold') return;
      await finish();
    },
    async handleActivation(event: ShortcutTriggerEvent): Promise<void> {
      if (event.triggerMode !== 'toggle') return;
      if (deps.recordingSession.isActive()) {
        await finish();
        return;
      }
      deps.recordingSession.begin(event.action);
    },
  };
}
```

- [ ] **Step 6: Run shortcut tests**

Run:

```powershell
bun test src/main/__tests__/shortcut-validation.test.ts src/main/__tests__/shortcut-trigger-controller.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/main/shortcuts src/main/__tests__/shortcut-validation.test.ts src/main/__tests__/shortcut-trigger-controller.test.ts
git commit -m "feat: add shortcut trigger controller"
```

### Task 3: Text Injection Result Semantics

**Files:**
- Modify: `D:\git_repos\speech-2-text\src\main\inject-text.ts`
- Modify: `D:\git_repos\speech-2-text\src\main\__tests__\inject-text.test.ts`
- Modify: `D:\git_repos\speech-2-text\src\main\index.ts`
- Modify: `D:\git_repos\speech-2-text\src\main\__tests__\index.test.ts`

- [ ] **Step 1: Add failing paste-blocked test**

In `src/main/__tests__/inject-text.test.ts`, add:

```ts
it('leaves transcript on clipboard when paste simulation fails', async () => {
  simulatePaste.mockImplementation(() => {
    throw new Error('paste blocked');
  });

  await expect(injectIntoFocusedApp('transcribed text', {
    readText,
    writeText,
    simulatePaste,
    delay,
  })).resolves.toEqual({
    status: 'paste-blocked',
    message: 'paste blocked',
  });

  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText).toHaveBeenCalledWith('transcribed text');
});
```

- [ ] **Step 2: Run failing injection test**

Run:

```powershell
bun test src/main/__tests__/inject-text.test.ts
```

Expected: FAIL because `injectIntoFocusedApp` currently throws and returns `void`.

- [ ] **Step 3: Return injection results**

Update `src/main/inject-text.ts`:

```ts
export type TextInjectionResult =
  | { status: 'injected' }
  | { status: 'paste-blocked'; message: string };

export async function injectIntoFocusedApp(
  text: string,
  deps: InjectTextDeps = defaultDeps
): Promise<TextInjectionResult> {
  const originalClipboard = deps.readText();

  deps.writeText(text);
  await deps.delay(50);

  try {
    deps.simulatePaste();
    await deps.delay(100);
  } catch (error) {
    return {
      status: 'paste-blocked',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (originalClipboard) {
    deps.writeText(originalClipboard);
  }

  return { status: 'injected' };
}
```

- [ ] **Step 4: Update existing injection test expectations**

In the successful paste test, assert:

```ts
await expect(injectIntoFocusedApp('transcribed text', {
  readText,
  writeText,
  simulatePaste,
  delay,
})).resolves.toEqual({ status: 'injected' });
```

In the empty previous clipboard test, assert:

```ts
await expect(injectIntoFocusedApp('text', {
  readText,
  writeText,
  simulatePaste,
  delay,
})).resolves.toEqual({ status: 'injected' });
```

- [ ] **Step 5: Surface paste-blocked result in main process**

In `src/main/index.ts`, replace:

```ts
await injectIntoFocusedApp(result.text);
```

with:

```ts
const injection = await injectIntoFocusedApp(result.text);
if (injection.status === 'paste-blocked') {
  dialog.showMessageBox({
    type: 'warning',
    title: 'Paste blocked',
    message: 'Shuddhalekhan copied the transcript, but could not paste into the focused app.',
    detail: injection.message,
  });
}
```

- [ ] **Step 6: Add main-process degraded paste test**

In `src/main/__tests__/index.test.ts`, make `simulatePaste` throw in a new test:

```ts
it('keeps transcript on clipboard and warns when paste is blocked', async () => {
  simulatePaste.mockImplementation(() => {
    throw new Error('paste blocked');
  });
  ipcListeners.get('audio-window-ready')?.({});
  const [onStart, onStop] = keyboardStart.mock.calls[0] as [(intent: 'dictation' | 'agent') => void, () => void];
  onStart('dictation');
  onStop();

  await ipcListeners.get('audio-data-ready')?.({}, new Uint8Array(64).buffer);
  await new Promise((resolve) => setTimeout(resolve, 70));

  expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('transcribed text');
  expect(electronMock.clipboard.writeText).not.toHaveBeenCalledWith('original');
  expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Paste blocked',
  }));
});
```

- [ ] **Step 7: Run injection and main tests**

Run:

```powershell
bun test src/main/__tests__/inject-text.test.ts src/main/__tests__/index.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/main/inject-text.ts src/main/index.ts src/main/__tests__/inject-text.test.ts src/main/__tests__/index.test.ts
git commit -m "feat: report blocked paste injection"
```

### Task 4: Shortcut IPC Surface

**Files:**
- Modify: `D:\git_repos\speech-2-text\src\types\ipc.ts`
- Modify: `D:\git_repos\speech-2-text\src\main\index.ts`
- Modify: `D:\git_repos\speech-2-text\src\main\__tests__\index.test.ts`
- Modify: `D:\git_repos\speech-2-text\src\preload\__tests__\index.test.ts`

- [ ] **Step 1: Add IPC channel tests**

In `src/main/__tests__/index.test.ts`, add expected handlers:

```ts
'shortcuts:get',
'shortcuts:validate',
'shortcuts:save',
```

Then add:

```ts
it('validates and saves shortcut config through IPC', () => {
  const config = getConfig();
  const candidate = {
    action: 'dictation' as const,
    accelerator: 'Control+Space',
    triggerMode: 'toggle' as const,
    status: 'unassigned' as const,
  };

  expect(ipcHandlers.get('shortcuts:get')?.({})).toEqual(config.shortcuts);
  expect(ipcHandlers.get('shortcuts:validate')?.({}, candidate)).toEqual({ ok: true, status: 'ready' });
  ipcHandlers.get('shortcuts:save')?.({}, candidate);

  expect(setConfig).toHaveBeenCalledWith('shortcuts', {
    ...config.shortcuts,
    dictation: { ...candidate, status: 'ready' },
  });
});
```

- [ ] **Step 2: Add IPC types**

In `RendererToMainInvokeChannels`, add:

```ts
'shortcuts:get': () => Promise<AppConfig['shortcuts']>;
'shortcuts:validate': (binding: ShortcutBinding) => ShortcutValidationResponse;
'shortcuts:save': (binding: ShortcutBinding) => void;
```

Also add:

```ts
export type ShortcutValidationResponse =
  | { ok: true; status: 'ready' }
  | { ok: false; status: Exclude<ShortcutRegistrationStatus, 'ready'>; message: string };
```

- [ ] **Step 3: Register IPC handlers**

In `src/main/index.ts`, import:

```ts
import type { ShortcutBinding } from '../types/ipc';
import { validateShortcutBinding } from './shortcuts/validation';
```

Add handlers:

```ts
ipcMain.handle('shortcuts:get', () => getConfig().shortcuts);

ipcMain.handle('shortcuts:validate', (_event, binding: ShortcutBinding) => {
  return validateShortcutBinding(binding, getConfig().shortcuts);
});

ipcMain.handle('shortcuts:save', (_event, binding: ShortcutBinding) => {
  const config = getConfig();
  const validation = validateShortcutBinding(binding, config.shortcuts);
  if (!validation.ok) return;

  setConfig('shortcuts', {
    ...config.shortcuts,
    [binding.action]: { ...binding, status: 'ready' },
  });
});
```

- [ ] **Step 4: Run IPC tests**

Run:

```powershell
bun test src/main/__tests__/index.test.ts src/preload/__tests__/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/types/ipc.ts src/main/index.ts src/main/__tests__/index.test.ts src/preload/__tests__/index.test.ts
git commit -m "feat: expose shortcut settings IPC"
```

### Task 5: Focused Recorder Sheet UI

**Files:**
- Modify: `D:\git_repos\speech-2-text\src\renderer\SettingsWindow.tsx`
- Modify: `D:\git_repos\speech-2-text\src\renderer\settings\settings-ipc.ts`
- Test: `D:\git_repos\speech-2-text\src\renderer\settings\__tests__\settings-ipc.test.ts`

- [ ] **Step 1: Add settings IPC shortcut methods test**

In `src/renderer/settings/__tests__/settings-ipc.test.ts`, assert that `createSettingsIpc` exposes:

```ts
await settings.getShortcuts();
await settings.validateShortcut({
  action: 'dictation',
  accelerator: 'Control+Space',
  triggerMode: 'toggle',
  status: 'unassigned',
});
await settings.saveShortcut({
  action: 'dictation',
  accelerator: 'Control+Space',
  triggerMode: 'toggle',
  status: 'ready',
});

expect(api.invoke).toHaveBeenCalledWith('shortcuts:get');
expect(api.invoke).toHaveBeenCalledWith('shortcuts:validate', expect.objectContaining({ action: 'dictation' }));
expect(api.invoke).toHaveBeenCalledWith('shortcuts:save', expect.objectContaining({ action: 'dictation' }));
```

- [ ] **Step 2: Add settings IPC methods**

In `src/renderer/settings/settings-ipc.ts`, add:

```ts
getShortcuts: () => api.invoke('shortcuts:get'),
validateShortcut: (binding: ShortcutBinding) => api.invoke('shortcuts:validate', binding),
saveShortcut: (binding: ShortcutBinding) => api.invoke('shortcuts:save', binding),
```

Import `ShortcutBinding` from `src/types/ipc`.

- [ ] **Step 3: Replace static hotkey rows**

In `SettingsWindow.tsx`, replace the two static `KeyRow` calls with a `ShortcutSettings` component:

```tsx
<ShortcutSettings
  shortcuts={config.shortcuts}
  agentEnabled={config.agent.enabled}
  onValidate={settingsIpc.validateShortcut}
  onSave={async (binding) => {
    await settingsIpc.saveShortcut(binding);
    const next = await settingsIpc.getConfig();
    setConfigState(next);
  }}
/>
```

- [ ] **Step 4: Add focused recorder component**

In `SettingsWindow.tsx`, add local component functions:

```tsx
function ShortcutSettings({
  shortcuts,
  agentEnabled,
  onValidate,
  onSave,
}: {
  shortcuts: AppConfig['shortcuts'];
  agentEnabled: boolean;
  onValidate: (binding: ShortcutBinding) => Promise<ShortcutValidationResponse>;
  onSave: (binding: ShortcutBinding) => Promise<void>;
}) {
  const [editing, setEditing] = useState<ShortcutBinding | null>(null);
  const [validation, setValidation] = useState<ShortcutValidationResponse | null>(null);

  if (editing) {
    return (
      <div className="space-y-4 border-b border-border py-5">
        <div>
          <p className="text-sm font-medium">
            Record {editing.action === 'dictation' ? 'Dictation' : 'Agent Mode'} shortcut
          </p>
          <p className="text-xs text-muted-foreground">Press a shortcut, choose hold or toggle, then save.</p>
        </div>
        <Input
          value={editing.accelerator ?? ''}
          placeholder="Press shortcut"
          onKeyDown={(event) => {
            event.preventDefault();
            const parts = [];
            if (event.ctrlKey) parts.push('Control');
            if (event.altKey) parts.push('Alt');
            if (event.metaKey) parts.push('Meta');
            if (event.shiftKey) parts.push('Shift');
            if (!['Control', 'Alt', 'Meta', 'Shift'].includes(event.key)) parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
            const next = { ...editing, accelerator: parts.join('+') };
            setEditing(next);
            onValidate(next).then(setValidation);
          }}
        />
        <div className="inline-flex rounded-md border border-border p-1">
          {(['hold', 'toggle'] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              variant={editing.triggerMode === mode ? 'default' : 'ghost'}
              onClick={() => setEditing({ ...editing, triggerMode: mode })}
            >
              {mode === 'hold' ? 'Hold' : 'Toggle'}
            </Button>
          ))}
        </div>
        {validation && !validation.ok ? <p className="text-xs text-destructive">{validation.message}</p> : null}
        {validation?.ok ? <p className="text-xs text-muted-foreground">Shortcut available.</p> : null}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
          <Button
            type="button"
            disabled={!validation?.ok}
            onClick={async () => {
              await onSave({ ...editing, status: 'ready' });
              setEditing(null);
              setValidation(null);
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <ShortcutRow binding={shortcuts.dictation} onEdit={() => setEditing(shortcuts.dictation)} />
      <ShortcutRow
        binding={shortcuts.agent}
        disabled={!agentEnabled}
        disabledLabel="Inactive until Agent Mode is enabled"
        onEdit={() => setEditing(shortcuts.agent)}
      />
    </>
  );
}
```

Add `ShortcutRow`:

```tsx
function ShortcutRow({
  binding,
  disabled = false,
  disabledLabel,
  onEdit,
}: {
  binding: ShortcutBinding;
  disabled?: boolean;
  disabledLabel?: string;
  onEdit: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border py-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-medium">{binding.action === 'dictation' ? 'Dictation hotkey' : 'Agent hotkey'}</p>
        <p className="text-xs text-muted-foreground">
          {disabled ? disabledLabel : binding.status === 'ready' ? `${binding.triggerMode} mode` : 'Unassigned'}
        </p>
      </div>
      <Button type="button" variant="outline" disabled={disabled} onClick={onEdit}>
        {binding.accelerator ?? 'Record'}
      </Button>
    </div>
  );
}
```

- [ ] **Step 5: Import needed types**

In `SettingsWindow.tsx`, add imports:

```ts
import type { ShortcutBinding, ShortcutValidationResponse } from '../types/ipc';
```

- [ ] **Step 6: Run renderer/settings checks**

Run:

```powershell
bun test src/renderer/settings/__tests__/settings-ipc.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/renderer/SettingsWindow.tsx src/renderer/settings/settings-ipc.ts src/renderer/settings/__tests__/settings-ipc.test.ts
git commit -m "feat: add focused shortcut recorder"
```

### Task 6: Verification

**Files:**
- All files touched in this plan.

- [ ] **Step 1: Run full verification**

Run:

```powershell
bun run lint
bun run typecheck
bun test
```

Expected: all pass.

- [ ] **Step 2: Confirm no build artifacts were created**

Run:

```powershell
git status --short
```

Expected: only intended source/test changes appear. `out/` and `release/` must not be staged.

- [ ] **Step 3: Commit verification fixes if needed**

If lint/typecheck fixes were needed:

```powershell
git status --short
git add path/to/file1 path/to/file2
git commit -m "test: verify shortcut configuration flow"
```
