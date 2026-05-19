# Cross-Platform Providers And Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add platform provider boundaries and capability reporting for Windows, macOS, and Linux without claiming unsupported desktop behavior.

**Architecture:** Introduce provider interfaces and platform selection modules that isolate shortcut, text injection, and capability behavior. Keep Windows wired to the existing `koffi` implementation. macOS and Linux providers begin with honest capability reporting and minimal Electron/desktop integration hooks.

**Tech Stack:** Electron main, TypeScript provider modules, Bun tests.

**Scope Guard:** Normalizing Windows away from `koffi` is a future refactor after Electron APIs prove they can preserve Windows behavior. Do not remove, replace, or bypass the current Windows `koffi` modules in this plan.

---

### Task 1: Provider Capability Types

**Files:**
- Create: `D:\git_repos\speech-2-text\src\main\platform\types.ts`
- Test: `D:\git_repos\speech-2-text\src\main\__tests__\platform-types.test.ts`

- [ ] **Step 1: Write capability type smoke test**

Create `src/main/__tests__/platform-types.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import type { PlatformCapabilities } from '../platform/types';

describe('PlatformCapabilities', () => {
  it('represents unsupported shortcut and paste states independently', () => {
    const capabilities: PlatformCapabilities = {
      platform: 'linux',
      desktop: 'gnome-wayland',
      shortcuts: {
        dictation: { state: 'needsSetup', message: 'Configure a desktop shortcut in GNOME Settings.' },
        agent: { state: 'unassigned', message: 'Agent Mode shortcut is not assigned.' },
      },
      textInjection: { state: 'unsupported', message: 'Paste simulation is not available in this session.' },
    };

    expect(capabilities.shortcuts.dictation.state).toBe('needsSetup');
    expect(capabilities.textInjection.state).toBe('unsupported');
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```powershell
bun test src/main/__tests__/platform-types.test.ts
```

Expected: FAIL because `src/main/platform/types.ts` does not exist.

- [ ] **Step 3: Add provider types**

Create `src/main/platform/types.ts`:

```ts
import type { RecordingIntent } from '../../types/ipc';

export type SupportedPlatform = 'win32' | 'darwin' | 'linux';

export type CapabilityState =
  | 'ready'
  | 'unassigned'
  | 'needsSetup'
  | 'blocked'
  | 'unsupported';

export interface CapabilityStatus {
  state: CapabilityState;
  message: string;
}

export interface PlatformCapabilities {
  platform: SupportedPlatform;
  desktop: string;
  shortcuts: Record<RecordingIntent, CapabilityStatus>;
  textInjection: CapabilityStatus;
}

export interface PlatformProvider {
  getCapabilities: () => PlatformCapabilities;
}
```

- [ ] **Step 4: Run type test**

Run:

```powershell
bun test src/main/__tests__/platform-types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/platform/types.ts src/main/__tests__/platform-types.test.ts
git commit -m "feat: define platform capability model"
```

### Task 2: Platform Provider Selection

**Files:**
- Create: `D:\git_repos\speech-2-text\src\main\platform\windows-provider.ts`
- Create: `D:\git_repos\speech-2-text\src\main\platform\macos-provider.ts`
- Create: `D:\git_repos\speech-2-text\src\main\platform\linux-provider.ts`
- Create: `D:\git_repos\speech-2-text\src\main\platform\index.ts`
- Test: `D:\git_repos\speech-2-text\src\main\__tests__\platform-provider.test.ts`

- [ ] **Step 1: Write platform selection tests**

Create `src/main/__tests__/platform-provider.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { createPlatformProviderForTest } from '../platform';

describe('createPlatformProvider', () => {
  it('selects Windows provider without changing the koffi implementation', () => {
    const provider = createPlatformProviderForTest('win32');
    expect(provider.getCapabilities().platform).toBe('win32');
    expect(provider.getCapabilities().shortcuts.dictation.state).toBe('ready');
  });

  it('selects macOS provider with explicit experimental capability states', () => {
    const provider = createPlatformProviderForTest('darwin');
    const capabilities = provider.getCapabilities();

    expect(capabilities.platform).toBe('darwin');
    expect(capabilities.shortcuts.dictation.state).toBe('unassigned');
  });

  it('selects Linux provider with GNOME Wayland setup status when relevant', () => {
    const provider = createPlatformProviderForTest('linux', { XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_TYPE: 'wayland' });
    const capabilities = provider.getCapabilities();

    expect(capabilities.platform).toBe('linux');
    expect(capabilities.desktop).toBe('gnome-wayland');
    expect(capabilities.shortcuts.dictation.state).toBe('needsSetup');
  });
});
```

- [ ] **Step 2: Run failing provider test**

Run:

```powershell
bun test src/main/__tests__/platform-provider.test.ts
```

Expected: FAIL because provider files do not exist.

- [ ] **Step 3: Implement Windows provider**

Create `src/main/platform/windows-provider.ts`:

```ts
import type { PlatformProvider } from './types';

export function createWindowsProvider(): PlatformProvider {
  return {
    getCapabilities: () => ({
      platform: 'win32',
      desktop: 'windows',
      shortcuts: {
        dictation: { state: 'ready', message: 'Windows shortcut provider is available.' },
        agent: { state: 'ready', message: 'Windows shortcut provider is available.' },
      },
      textInjection: { state: 'ready', message: 'Windows paste simulation is available.' },
    }),
  };
}
```

Do not import or edit `src/main/native/keyboard.ts` or `src/main/native/clipboard.ts`.

- [ ] **Step 4: Implement macOS provider**

Create `src/main/platform/macos-provider.ts`:

```ts
import type { PlatformProvider } from './types';

export function createMacosProvider(): PlatformProvider {
  return {
    getCapabilities: () => ({
      platform: 'darwin',
      desktop: 'macos',
      shortcuts: {
        dictation: { state: 'unassigned', message: 'Record a macOS shortcut in Settings.' },
        agent: { state: 'unassigned', message: 'Record a macOS shortcut in Settings.' },
      },
      textInjection: {
        state: 'needsSetup',
        message: 'macOS may require Accessibility permission before Shuddhalekhan can paste into other apps.',
      },
    }),
  };
}
```

- [ ] **Step 5: Implement Linux provider**

Create `src/main/platform/linux-provider.ts`:

```ts
import type { PlatformProvider } from './types';

function detectLinuxDesktop(env: NodeJS.ProcessEnv): string {
  const desktop = (env.XDG_CURRENT_DESKTOP ?? '').toLowerCase();
  const session = (env.XDG_SESSION_TYPE ?? '').toLowerCase();

  if (desktop.includes('gnome') && session === 'wayland') return 'gnome-wayland';
  if (session === 'x11') return 'x11';
  if (session === 'wayland') return 'wayland-unverified';
  return 'linux-unknown';
}

export function createLinuxProvider(env: NodeJS.ProcessEnv = process.env): PlatformProvider {
  const desktop = detectLinuxDesktop(env);
  const shortcutState = desktop === 'gnome-wayland'
    ? { state: 'needsSetup' as const, message: 'Configure the shortcut through GNOME Settings.' }
    : { state: 'unsupported' as const, message: 'Shortcut support is unverified for this Linux desktop session.' };

  return {
    getCapabilities: () => ({
      platform: 'linux',
      desktop,
      shortcuts: {
        dictation: shortcutState,
        agent: shortcutState,
      },
      textInjection: {
        state: desktop === 'x11' ? 'needsSetup' : 'unsupported',
        message: desktop === 'x11'
          ? 'Paste simulation requires desktop validation on X11.'
          : 'Paste simulation is not verified for this Linux desktop session.',
      },
    }),
  };
}
```

- [ ] **Step 6: Implement provider index**

Create `src/main/platform/index.ts`:

```ts
import { createLinuxProvider } from './linux-provider';
import { createMacosProvider } from './macos-provider';
import type { PlatformProvider, SupportedPlatform } from './types';
import { createWindowsProvider } from './windows-provider';

export function createPlatformProvider(): PlatformProvider {
  return createPlatformProviderForTest(process.platform as SupportedPlatform);
}

export function createPlatformProviderForTest(
  platform: SupportedPlatform,
  env: NodeJS.ProcessEnv = process.env
): PlatformProvider {
  if (platform === 'darwin') return createMacosProvider();
  if (platform === 'linux') return createLinuxProvider(env);
  return createWindowsProvider();
}
```

- [ ] **Step 7: Run provider tests**

Run:

```powershell
bun test src/main/__tests__/platform-provider.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/main/platform src/main/__tests__/platform-provider.test.ts
git commit -m "feat: add platform provider selection"
```

### Task 3: Expose Capabilities Through IPC

**Files:**
- Modify: `D:\git_repos\speech-2-text\src\types\ipc.ts`
- Modify: `D:\git_repos\speech-2-text\src\main\index.ts`
- Modify: `D:\git_repos\speech-2-text\src\main\__tests__\index.test.ts`
- Modify: `D:\git_repos\speech-2-text\src\renderer\settings\settings-ipc.ts`
- Modify: `D:\git_repos\speech-2-text\src\renderer\settings\__tests__\settings-ipc.test.ts`

- [ ] **Step 1: Add main IPC test**

In `src/main/__tests__/index.test.ts`, expect `platform:get-capabilities` in the handler list and add:

```ts
it('returns platform capability status', () => {
  const capabilities = ipcHandlers.get('platform:get-capabilities')?.({});

  expect(capabilities).toEqual(expect.objectContaining({
    platform: 'win32',
    shortcuts: expect.objectContaining({
      dictation: expect.objectContaining({ state: 'ready' }),
    }),
  }));
});
```

- [ ] **Step 2: Add IPC type**

In `src/types/ipc.ts`, import or define a serializable capability type:

```ts
export type PlatformCapabilityState = 'ready' | 'unassigned' | 'needsSetup' | 'blocked' | 'unsupported';

export interface PlatformCapabilityStatus {
  state: PlatformCapabilityState;
  message: string;
}

export interface PlatformCapabilitiesSnapshot {
  platform: 'win32' | 'darwin' | 'linux';
  desktop: string;
  shortcuts: Record<RecordingIntent, PlatformCapabilityStatus>;
  textInjection: PlatformCapabilityStatus;
}
```

Add invoke channel:

```ts
'platform:get-capabilities': () => Promise<PlatformCapabilitiesSnapshot>;
```

- [ ] **Step 3: Register main handler**

In `src/main/index.ts`, import:

```ts
import { createPlatformProvider } from './platform';
```

Create near other singletons:

```ts
const platformProvider = createPlatformProvider();
```

Add handler:

```ts
ipcMain.handle('platform:get-capabilities', () => platformProvider.getCapabilities());
```

- [ ] **Step 4: Add settings IPC method**

In `src/renderer/settings/settings-ipc.ts`, add:

```ts
getPlatformCapabilities: () => api.invoke('platform:get-capabilities'),
```

In `src/renderer/settings/__tests__/settings-ipc.test.ts`, assert:

```ts
await settings.getPlatformCapabilities();
expect(api.invoke).toHaveBeenCalledWith('platform:get-capabilities');
```

- [ ] **Step 5: Run IPC tests**

Run:

```powershell
bun test src/main/__tests__/index.test.ts src/renderer/settings/__tests__/settings-ipc.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/types/ipc.ts src/main/index.ts src/main/__tests__/index.test.ts src/renderer/settings/settings-ipc.ts src/renderer/settings/__tests__/settings-ipc.test.ts
git commit -m "feat: expose platform capabilities"
```

### Task 4: Settings Capability Status

**Files:**
- Modify: `D:\git_repos\speech-2-text\src\renderer\SettingsWindow.tsx`

- [ ] **Step 1: Load capabilities in Settings**

In `SettingsWindow.tsx`, add state:

```ts
const [platformCapabilities, setPlatformCapabilities] = useState<PlatformCapabilitiesSnapshot | null>(null);
```

Load it inside the existing `useEffect`:

```ts
settingsIpc.getPlatformCapabilities().then(setPlatformCapabilities).catch((err) => {
  console.error('Failed to load platform capabilities:', err);
});
```

- [ ] **Step 2: Show general status rows**

In the General settings panel, below shortcut rows, add:

```tsx
{platformCapabilities ? (
  <>
    <ReadOnlyRow label="Desktop session" value={platformCapabilities.desktop} />
    <ReadOnlyRow label="Text injection" value={`${platformCapabilities.textInjection.state}: ${platformCapabilities.textInjection.message}`} />
  </>
) : null}
```

- [ ] **Step 3: Use capability state in shortcut UI**

If the hotkey plan has already added `ShortcutSettings`, pass `platformCapabilities` into it and show the per-action message under each action. If it has not, add read-only rows:

```tsx
{platformCapabilities ? (
  <>
    <ReadOnlyRow label="Dictation shortcut status" value={`${platformCapabilities.shortcuts.dictation.state}: ${platformCapabilities.shortcuts.dictation.message}`} />
    <ReadOnlyRow label="Agent shortcut status" value={`${platformCapabilities.shortcuts.agent.state}: ${platformCapabilities.shortcuts.agent.message}`} />
  </>
) : null}
```

- [ ] **Step 4: Run checks**

Run:

```powershell
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/SettingsWindow.tsx
git commit -m "feat: show platform capability status"
```

### Task 5: Documentation And Support Boundaries

**Files:**
- Modify: `D:\git_repos\speech-2-text\README.md`
- Modify: `D:\git_repos\speech-2-text\CONTRIBUTING.md`

- [ ] **Step 1: Document experimental platform support**

Add to `README.md`:

```markdown
## Platform Support

Windows is the current stable platform. Linux and macOS builds may be published as Experimental or Developer Preview artifacts while global shortcuts, focused-app paste injection, tray behavior, and permission flows are validated.

Linux validation starts with GNOME on Wayland and Debian/Ubuntu `.deb` packages. Other Wayland compositors and desktop environments are community-validation targets until explicitly tested.

macOS Developer Preview builds may be unsigned. Stable macOS support requires signing, notarization, and validated Accessibility/microphone permission flows.
```

- [ ] **Step 2: Document provider scope**

Add to `CONTRIBUTING.md`:

```markdown
### Platform Providers

Platform-specific desktop behavior belongs behind provider modules under `src/main/platform/`. Providers report capability state and adapt platform behavior into existing recording and injection flows.

Do not replace the Windows `koffi` implementation as part of cross-platform provider work. Normalizing Windows away from `koffi` is a separate future refactor after Electron APIs prove they can preserve current Windows behavior.
```

- [ ] **Step 3: Commit**

```powershell
git add README.md CONTRIBUTING.md
git commit -m "docs: define platform support boundaries"
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

- [ ] **Step 2: Confirm no platform build outputs**

Run:

```powershell
git status --short
```

Expected: no `out/` or `release/` artifacts are staged.

- [ ] **Step 3: Commit verification fixes if needed**

```powershell
git status --short
git add path/to/file1 path/to/file2
git commit -m "test: verify platform provider boundaries"
```
