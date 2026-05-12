# Multilingual Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add language selection and transcription/translation task mode to the Whisper dictation pipeline, configurable from Settings → Audio.

**Architecture:** Two new `AppConfig` fields (`language` and `task`) flow through the existing electron-store config system. The `transcribe()` function in `whisper.ts` appends them as multipart form fields alongside existing `temperature` and `response_format`. The Settings UI renders a language dropdown and task mode selector in the Audio section using the existing `Select` component from shadcn/radix-ui.

**Tech Stack:** TypeScript, React, electron-store, radix-ui Select, bun test

---

## File Impact Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/types/ipc.ts` | Modify | Add `language: string`, `task: 'transcribe' \| 'translate'` to `AppConfig` |
| `src/main/config.ts` | Modify | Add `language: ''`, `task: 'transcribe'` defaults |
| `src/main/whisper.ts` | Modify | Append `language` and `task` form fields when set |
| `src/renderer/SettingsWindow.tsx` | Modify | Add language dropdown + task selector to Audio section |
| `src/main/__tests__/whisper.test.ts` | Modify | Verify new form fields are sent correctly |
| `src/main/__tests__/config.test.ts` | Modify | Update expected default snapshots to include new fields |

No new files are created. No new dependencies are added.

---

### Task 1: Add language and task to AppConfig type

**Files:**
- Modify: `src/types/ipc.ts:139-153`

- [ ] **Step 1: Add fields to the AppConfig interface**

```typescript
export interface AppConfig {
  whisperUrl: string;
  selectedDeviceId: string | null;
  removeFillerWords: boolean;
  language: string;
  task: 'transcribe' | 'translate';
  agent: {
    enabled: boolean;
    provider: {
      baseUrl: string;
      model: string;
      apiKeyEnvVar: string;
      thinkingEnabled: boolean;
    };
    mcpServers: McpServerConfig[];
  };
}
```

- [ ] **Step 2: Run typecheck to verify no downstream breaks yet**

Run: `bun run typecheck`
Expected: errors in `config.ts` and `whisper.ts` and `SettingsWindow.tsx` because they construct `AppConfig` objects without `language`/`task` — expected at this stage.

- [ ] **Step 3: Commit**

```bash
git add src/types/ipc.ts
git commit -m "feat: add language and task fields to AppConfig type"
```

---

### Task 2: Add defaults in config.ts and update config tests

**Files:**
- Modify: `src/main/config.ts:12-29`
- Modify: `src/main/__tests__/config.test.ts:49-63,72-88,100-113,123-139`

- [ ] **Step 1: Add defaults to the electron-store constructor**

In `src/main/config.ts`, replace lines 14-28 (the `defaults` object):

```typescript
const store = new Store<StoreConfig>({
  name: 'shuddhalekhan-config',
  defaults: {
    whisperUrl: 'http://localhost:8080/inference',
    selectedDeviceId: null,
    removeFillerWords: true,
    language: '',
    task: 'transcribe',
    agent: {
      enabled: false,
      provider: {
        baseUrl: '',
        model: '',
        apiKeyEnvVar: '',
        thinkingEnabled: true,
      },
      mcpServers: [],
    },
  },
});
```

- [ ] **Step 2: Also add language/task to the getConfig() return value**

In `src/main/config.ts`, update the `getConfig()` return object (lines 62-80):

```typescript
export function getConfig(): AppConfig {
  const agent = store.get('agent');
  const mcpServers = normalizeMcpServers(agent?.mcpServers);

  return {
    whisperUrl: store.get('whisperUrl'),
    selectedDeviceId: store.get('selectedDeviceId'),
    removeFillerWords: store.get('removeFillerWords'),
    language: store.get('language'),
    task: store.get('task'),
    agent: {
      enabled: agent?.enabled ?? false,
      provider: {
        baseUrl: agent?.provider?.baseUrl ?? '',
        model: agent?.provider?.model ?? '',
        apiKeyEnvVar: agent?.provider?.apiKeyEnvVar ?? '',
        thinkingEnabled: agent?.provider?.thinkingEnabled ?? true,
      },
      mcpServers,
    },
  };
}
```

- [ ] **Step 3: Update config test — "returns defaults when no legacy config exists"**

In `src/main/__tests__/config.test.ts`, update the expected default in the first test (lines 49-63) to include `language` and `task`:

```typescript
it('returns defaults when no legacy config exists', async () => {
  existsSync.mockReturnValue(false);
  const { getConfig } = await import(`../config?test=${Date.now()}-1`);

  expect(getConfig()).toEqual({
    whisperUrl: 'http://localhost:8080/inference',
    selectedDeviceId: null,
    removeFillerWords: true,
    language: '',
    task: 'transcribe',
    agent: {
      enabled: false,
      provider: {
        baseUrl: '',
        model: '',
        apiKeyEnvVar: '',
        thinkingEnabled: true,
      },
      mcpServers: [],
    },
  });
});
```

- [ ] **Step 4: Update all other config test snapshots**

Update the expected objects in the remaining tests to include `language: ''` and `task: 'transcribe'`:
- "sets typed config values" (lines 73-88)
- "migrates and deletes the legacy config once" (lines 100-113)
- "ignores malformed legacy config and keeps defaults" (lines 125-139)

Every `.toEqual()` call that includes the full config must now include `language: ''` and `task: 'transcribe'`.

- [ ] **Step 5: Run config tests**

Run: `bun test src/main/__tests__/config.test.ts`
Expected: All 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/config.ts src/main/__tests__/config.test.ts
git commit -m "feat: add language and task defaults to config store"
```

---

### Task 3: Update whisper.ts to send language and task

**Files:**
- Modify: `src/main/whisper.ts:3-17`
- Modify: `src/main/__tests__/whisper.test.ts:7-21,38-55`

- [ ] **Step 1: Pass language and task as form fields**

In `src/main/whisper.ts`, update the `transcribe()` function to read `language` and `task` from config and pass them as form fields. Replace lines 3-18:

```typescript
import type { AppConfig } from '../types/ipc';

export async function transcribe(audioData: Uint8Array, config?: AppConfig): Promise<string> {
  const { whisperUrl, removeFillerWords, language, task } = config ?? await loadRuntimeConfig();

  const form = new FormData();
  const blob = new Blob([audioData], { type: 'audio/wav' });
  form.append('file', blob, 'audio.wav');
  form.append('temperature', '0.2');
  form.append('response_format', 'json');

  if (language) {
    form.append('language', language);
  }

  if (task && task !== 'transcribe') {
    form.append('task', task);
  }

  if (removeFillerWords) {
    form.append(
      'prompt',
      'The following is a clear, formal transcript without any stutters, repetitions, or filler words like um and ah.'
    );
  }

  const response = await fetch(whisperUrl, {
    method: 'POST',
    body: form as unknown as BodyInit,
  });

  // ... rest remains unchanged
```

- [ ] **Step 2: Update whisper test config fixture**

In `src/main/__tests__/whisper.test.ts`, update the test config (lines 7-21) to include the new fields:

```typescript
const config: AppConfig = {
  whisperUrl: 'http://whisper.test/inference',
  selectedDeviceId: null,
  removeFillerWords: true,
  language: '',
  task: 'transcribe',
  agent: {
    enabled: false,
    provider: {
      baseUrl: '',
      model: '',
      apiKeyEnvVar: '',
      thinkingEnabled: true,
    },
    mcpServers: [],
  },
};
```

- [ ] **Step 3: Add test for language and task form field passing**

Add a new test after the existing `transcribe` tests (before the describe block ends at line 95). Place it after line 55 (after the first transcribe test):

```typescript
it('appends language and task form fields when configured', async () => {
  const fetchMock = fetch as unknown as ReturnType<typeof mock>;
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ text: 'translated text' }),
  } as Response);

  await transcribe(new Uint8Array([1]), { ...config, language: 'mr', task: 'translate' });

  const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
  expect(body.get('language')).toBe('mr');
  expect(body.get('task')).toBe('translate');
});

it('omits language when empty and task when transcribe (default)', async () => {
  const fetchMock = fetch as unknown as ReturnType<typeof mock>;
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ text: 'hello' }),
  } as Response);

  await transcribe(new Uint8Array([1]), config);

  const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
  expect(body.has('language')).toBe(false);
  expect(body.has('task')).toBe(false);
});
```

- [ ] **Step 4: Run whisper tests**

Run: `bun test src/main/__tests__/whisper.test.ts`
Expected: All 6 tests pass (4 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/main/whisper.ts src/main/__tests__/whisper.test.ts
git commit -m "feat: send language and task to Whisper endpoint"
```

---

### Task 4: Add language dropdown and task selector to Settings UI

**Files:**
- Modify: `src/renderer/SettingsWindow.tsx:144-155`

- [ ] **Step 1: Create the WHISPER_LANGUAGES constant and SelectRow component**

Add these above the `SettingsWindow` function component in `src/renderer/SettingsWindow.tsx`. Place them after the `sections` array but before `export function SettingsWindow()`:

```typescript
const WHISPER_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Auto-detect' },
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi (हिन्दी)' },
  { value: 'mr', label: 'Marathi (मराठी)' },
  { value: 'gu', label: 'Gujarati (ગુજરાતી)' },
  { value: 'bn', label: 'Bengali (বাংলা)' },
  { value: 'ta', label: 'Tamil (தமிழ்)' },
  { value: 'te', label: 'Telugu (తెలుగు)' },
  { value: 'kn', label: 'Kannada (ಕನ್ನಡ)' },
  { value: 'ml', label: 'Malayalam (മലയാളം)' },
  { value: 'pa', label: 'Punjabi (ਪੰਜਾਬੀ)' },
  { value: 'ur', label: 'Urdu (اردو)' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'de', label: 'German' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ko', label: 'Korean' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ar', label: 'Arabic' },
  { value: 'ru', label: 'Russian' },
];
```

- [ ] **Step 2: Add imports for Select components**

In `src/renderer/SettingsWindow.tsx`, add Select imports alongside the existing UI imports (after line 11, the `Label` import):

```typescript
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
```

- [ ] **Step 3: Add the SelectRow helper component**

Add after `ReadOnlyRow` but before the `import { Windows as WindowsIcon }` line (after line 307):

```typescript
function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2 border-b border-border py-5">
      <Label className="text-sm font-medium">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full max-w-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value || '__auto__'} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
```

- [ ] **Step 4: Add language and task UI to the Audio section**

In the Audio section (the `{activeSection === 'audio' ? ...}` block, lines 144-155), add the two new rows after the existing `TextRow` for whisper endpoint and before the read-only rows:

```typescript
{activeSection === 'audio' ? (
  <SettingsPanel>
    <TextRow
      label="Whisper endpoint"
      value={config.whisperUrl}
      placeholder="http://localhost:8080/inference"
      onChange={(value) => updateConfig('whisperUrl', value)}
    />
    <SelectRow
      label="Task"
      value={config.task}
      options={[
        { value: 'transcribe', label: 'Transcribe (same language)' },
        { value: 'translate', label: 'Translate (to English)' },
      ]}
      onChange={(value) => updateConfig('task', value as AppConfig['task'])}
    />
    <SelectRow
      label="Language"
      value={config.language}
      options={WHISPER_LANGUAGES}
      onChange={(value) => updateConfig('language', value)}
    />
    <ReadOnlyRow label="Selected device" value={config.selectedDeviceId ?? 'Default input device'} />
    <ReadOnlyRow label="Capture path" value="Shared by Dictation and Agent Mode" />
  </SettingsPanel>
) : null}
```

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 6: Run lint**

Run: `bun run lint`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/SettingsWindow.tsx
git commit -m "feat: add language and task selectors to Audio settings"
```

---

### Task 5: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: No errors.

- [ ] **Step 4: Commit** (if any fixup was needed)

No commit needed if everything passes.
