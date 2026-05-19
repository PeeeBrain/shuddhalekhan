import { useEffect, useMemo, useState } from 'react';
import type {
  AppConfig,
  AppInfo,
  McpServerConfig,
  McpServerRuntimeStatus,
  PlatformCapabilitiesSnapshot,
  ShortcutBinding,
  ShortcutValidationResponse,
  UpdateStatus,
} from '../types/ipc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { X as XIcon } from 'lucide-react';
import { Windows as WindowsIcon } from '@/components/ui/svgs/windows';
import { McpSettings } from './settings/McpSettings';
import { createSettingsIpc } from './settings/settings-ipc';

type SettingsSection = 'general' | 'audio' | 'agent' | 'mcp' | 'about';

const sections: Array<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'audio', label: 'Audio' },
  { id: 'agent', label: 'Agent' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'about', label: 'About' },
];

const WHISPER_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto-detect' },
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

export function SettingsWindow() {
  const settingsIpc = useMemo(() => createSettingsIpc(window.electronAPI), []);
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [config, setConfigState] = useState<AppConfig | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [mcpStatuses, setMcpStatuses] = useState<Record<string, McpServerRuntimeStatus>>({});
  const [platformCapabilities, setPlatformCapabilities] = useState<PlatformCapabilitiesSnapshot | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle');

  useEffect(() => {
    settingsIpc.getConfig().then(setConfigState).catch((err) => {
      console.error('Failed to load settings config:', err);
    });
    settingsIpc.getAppInfo().then(setAppInfo).catch((err) => {
      console.error('Failed to load app info:', err);
    });
    settingsIpc.getUpdateStatus().then(setUpdateStatus).catch((err) => {
      console.error('Failed to load update status:', err);
    });
    settingsIpc.getPlatformCapabilities().then(setPlatformCapabilities).catch((err) => {
      console.error('Failed to load platform capabilities:', err);
    });

    const offUpdater = settingsIpc.onUpdateStatusChanged(setUpdateStatus);
    const offMcpStatus = settingsIpc.onMcpServerStatus((status) => {
      setMcpStatuses((current) => ({ ...current, [status.serverId]: status }));
      settingsIpc.getConfig().then(setConfigState).catch((err) => {
        console.error('Failed to refresh MCP tools:', err);
      });
    });

    return () => {
      offUpdater?.();
      offMcpStatus?.();
    };
  }, [settingsIpc]);

  const updateConfig = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    setConfigState((current) => current ? { ...current, [key]: value } : current);
    settingsIpc.setConfig(key, value);
    setSaveState('saved');
    window.setTimeout(() => setSaveState('idle'), 1200);
  };

  const updateAgent = (agent: AppConfig['agent']) => updateConfig('agent', agent);

  const statusText = useMemo(() => {
    if (!updateStatus) return 'Update status unavailable';
    return updateStatus.message;
  }, [updateStatus]);

  if (!config) {
    return (
      <main className="flex h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading settings...</p>
      </main>
    );
  }

  const updateMcpServers = (mcpServers: McpServerConfig[]) => updateAgent({ ...config.agent, mcpServers });

  return (
    <main className="flex h-screen bg-background text-foreground">
      <aside className="flex w-56 flex-col border-r border-border bg-background p-5 pt-6" aria-label="Settings sections">
        <div className="mb-6 flex items-center gap-3">
          <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary">
            <span className="text-primary text-lg font-bold leading-none">S</span>
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Shuddhalekhan</h1>
            <p className="text-xs text-muted-foreground">{appInfo?.version ? `v${appInfo.version}` : 'Settings'}</p>
          </div>
        </div>

        <nav className="flex flex-col gap-0.5">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              role="tab"
              aria-selected={activeSection === section.id}
              className={`flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none ${
                activeSection === section.id
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              }`}
              onClick={() => setActiveSection(section.id)}
            >
              {section.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="min-w-0 flex-1 bg-background">
        <ScrollArea className="h-full">
          <div className="px-10 py-8">
            <header className="mb-8 flex items-start justify-between gap-6">
              <h2 className="text-2xl font-semibold tracking-tight">
                {sections.find((section) => section.id === activeSection)?.label}
              </h2>
              <Badge variant="outline" className={saveState === 'saved' ? 'border-primary/45 text-primary' : ''}>
                {saveState === 'saved' ? 'Saved' : 'Ready'}
              </Badge>
            </header>

            {activeSection === 'general' ? (
              <SettingsPanel>
                <ToggleRow
                  title="Clean transcription"
                  description="Remove common filler words before dictation text is injected."
                  checked={config.removeFillerWords}
                  onChange={(checked) => updateConfig('removeFillerWords', checked)}
                />
                <ShortcutSettings
                  shortcuts={config.shortcuts}
                  agentEnabled={config.agent.enabled}
                  platform={platformCapabilities?.platform}
                  capabilities={platformCapabilities}
                  onValidate={settingsIpc.validateShortcut}
                  onSave={async (binding) => {
                    await settingsIpc.saveShortcut(binding);
                    const next = await settingsIpc.getConfig();
                    setConfigState(next);
                  }}
                />
                {platformCapabilities ? <PlatformSetupNotice capabilities={platformCapabilities} /> : null}
              </SettingsPanel>
            ) : null}

            {activeSection === 'audio' ? (
              <SettingsPanel>
                <TextRow
                  label="Whisper endpoint"
                  value={config.whisperUrl}
                  placeholder="http://localhost:8080/inference"
                  onChange={(value) => updateConfig('whisperUrl', value)}
                />
                <SelectRow
                  label="Mode"
                  value={config.task}
                  options={[
                    { value: 'transcribe', label: 'Transcribe spoken language' },
                    { value: 'translate', label: 'Translate speech to English' },
                  ]}
                  onChange={(value) => updateConfig('task', value as AppConfig['task'])}
                />
                <SelectRow
                  label="Spoken language"
                  value={config.language}
                  options={WHISPER_LANGUAGES}
                  onChange={(value) => updateConfig('language', value)}
                />
                <ReadOnlyRow label="Selected device" value={config.selectedDeviceId ?? 'Default input device'} />
                <ReadOnlyRow label="Capture path" value="Shared by Dictation and Agent Mode" />
                <div className="py-5 space-y-4 border-b border-border">
                  <div className="space-y-1">
                    <h3 className="text-sm font-medium">Personal Dictionary</h3>
                    <p className="text-xs text-muted-foreground">
                      Add specific names, technical terms, or acronyms to help Whisper spell them correctly. Press Enter to add.
                    </p>
                  </div>
                  <DictionaryInput 
                    dictionary={config.dictionary} 
                    onChange={(newDictionary) => updateConfig('dictionary', newDictionary)} 
                  />
                </div>
              </SettingsPanel>
            ) : null}

            {activeSection === 'agent' ? (
              <SettingsPanel>
                <ToggleRow
                  title="Enable Agent Mode"
                  description="Activates the Alt + Win recording intent. Sidecar execution arrives in later phases."
                  checked={config.agent.enabled}
                  tone="agent"
                  onChange={(checked) => updateAgent({ ...config.agent, enabled: checked })}
                />
                <TextRow
                  label="Provider base URL"
                  value={config.agent.provider.baseUrl}
                  placeholder="https://openrouter.ai/api/v1"
                  onChange={(baseUrl) => updateAgent({
                    ...config.agent,
                    provider: { ...config.agent.provider, baseUrl },
                  })}
                />
                <TextRow
                  label="Model"
                  value={config.agent.provider.model}
                  placeholder="openai/gpt-4.1-mini"
                  onChange={(model) => updateAgent({
                    ...config.agent,
                    provider: { ...config.agent.provider, model },
                  })}
                />
                <ToggleRow
                  title="Thinking"
                  description="Allows models that support thinking to spend extra reasoning before tool calls."
                  checked={config.agent.provider.thinkingEnabled}
                  tone="agent"
                  onChange={(thinkingEnabled) => updateAgent({
                    ...config.agent,
                    provider: { ...config.agent.provider, thinkingEnabled },
                  })}
                />
                <TextRow
                  label="API key env var name"
                  value={config.agent.provider.apiKeyEnvVar}
                  placeholder={isLocalProviderUrl(config.agent.provider.baseUrl) ? 'Optional for local providers' : 'OPENROUTER_API_KEY'}
                  warning={looksLikeRawApiKey(config.agent.provider.apiKeyEnvVar)
                    ? 'Enter the environment variable name here, not the API key value. Example: OPENROUTER_API_KEY.'
                    : isLocalProviderUrl(config.agent.provider.baseUrl)
                      ? 'Local providers such as Ollama can leave this empty.'
                      : undefined}
                  onChange={(apiKeyEnvVar) => updateAgent({
                    ...config.agent,
                    provider: { ...config.agent.provider, apiKeyEnvVar },
                  })}
                />
              </SettingsPanel>
            ) : null}

            {activeSection === 'mcp' ? (
              <McpSettings
                servers={config.agent.mcpServers}
                statuses={mcpStatuses}
                onChange={updateMcpServers}
                onTest={(serverId) => {
                  settingsIpc.testMcpServer(serverId);
                }}
              />
            ) : null}

            {activeSection === 'about' ? (
              <SettingsPanel>
                <ReadOnlyRow label="Version" value={appInfo?.version ?? 'Unknown'} />
                <ReadOnlyRow label="Update status" value={statusText} />
                <Button
                  className="mt-4 w-fit min-w-36"
                  disabled={updateStatus?.state === 'checking'}
                  onClick={() => {
                    settingsIpc.checkForUpdates().then(setUpdateStatus).catch((err) => {
                      console.error('Failed to check for updates:', err);
                    });
                  }}
                >
                  {updateStatus?.state === 'checking' ? 'Checking...' : 'Check for Updates'}
                </Button>
              </SettingsPanel>
            ) : null}
          </div>
        </ScrollArea>
      </section>
    </main>
  );
}

function SettingsPanel({ children }: { children: React.ReactNode }) {
  return <div className="max-w-2xl space-y-0 border-t border-border">{children}</div>;
}

function ToggleRow({
  title,
  description,
  checked,
  tone = 'default',
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  tone?: 'default' | 'agent';
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        className={tone === 'agent' && checked ? 'data-[state=checked]:bg-agent data-[state=checked]:border-agent/70' : ''}
      />
    </div>
  );
}

function TextRow({
  label,
  value,
  placeholder,
  warning,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  warning?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2 border-b border-border py-5">
      <Label className="text-sm font-medium">{label}</Label>
      <Input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      {warning ? <p className="text-xs text-destructive break-words">{warning}</p> : null}
    </div>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-5 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium break-words">{value}</span>
    </div>
  );
}

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

function ShortcutSettings({
  shortcuts,
  agentEnabled,
  platform,
  capabilities,
  onValidate,
  onSave,
}: {
  shortcuts: AppConfig['shortcuts'];
  agentEnabled: boolean;
  platform?: PlatformCapabilitiesSnapshot['platform'];
  capabilities: PlatformCapabilitiesSnapshot | null;
  onValidate: (binding: ShortcutBinding) => Promise<ShortcutValidationResponse>;
  onSave: (binding: ShortcutBinding) => Promise<void>;
}) {
  const [editing, setEditing] = useState<ShortcutBinding | null>(null);
  const [validation, setValidation] = useState<ShortcutValidationResponse | null>(null);

  const startEditing = (binding: ShortcutBinding) => {
    setEditing(binding);
    if (binding.accelerator) {
      onValidate(binding).then(setValidation);
    } else {
      setValidation(null);
    }
  };

  const updateEditing = (binding: ShortcutBinding) => {
    setEditing(binding);
    onValidate(binding).then(setValidation);
  };

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
          value={formatAccelerator(editing.accelerator, platform)}
          placeholder="Press shortcut"
          onKeyDown={(event) => {
            event.preventDefault();
            const parts = [];
            if (event.ctrlKey) parts.push('Control');
            if (event.altKey) parts.push('Alt');
            if (event.metaKey) parts.push('Meta');
            if (event.shiftKey) parts.push('Shift');
            if (!['Control', 'Alt', 'Meta', 'Shift'].includes(event.key)) parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
            updateEditing({ ...editing, accelerator: parts.join('+') });
          }}
        />
        <div className="inline-flex rounded-md border border-border p-1">
          {(['hold', 'toggle'] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              variant={editing.triggerMode === mode ? 'default' : 'ghost'}
              onClick={() => updateEditing({ ...editing, triggerMode: mode })}
            >
              {mode === 'hold' ? 'Hold' : 'Toggle'}
            </Button>
          ))}
        </div>
        {validation && !validation.ok ? <p className="text-xs text-destructive">{validation.message}</p> : null}
        {validation?.ok ? <p className="text-xs text-muted-foreground">Shortcut available.</p> : null}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setEditing(null);
              setValidation(null);
            }}
          >
            Cancel
          </Button>
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
      <ShortcutRow
        binding={shortcuts.dictation}
        platform={platform}
        capability={capabilities?.shortcuts.dictation}
        onEdit={() => startEditing(shortcuts.dictation)}
      />
      <ShortcutRow
        binding={shortcuts.agent}
        platform={platform}
        capability={capabilities?.shortcuts.agent}
        disabled={!agentEnabled}
        disabledLabel="Inactive until Agent Mode is enabled"
        onEdit={() => startEditing(shortcuts.agent)}
      />
    </>
  );
}

function ShortcutRow({
  binding,
  platform,
  capability,
  disabled = false,
  disabledLabel,
  onEdit,
}: {
  binding: ShortcutBinding;
  platform?: PlatformCapabilitiesSnapshot['platform'];
  capability?: PlatformCapabilitiesSnapshot['shortcuts']['dictation'];
  disabled?: boolean;
  disabledLabel?: string;
  onEdit: () => void;
}) {
  const needsAttention = !disabled && (binding.status !== 'ready' || (capability && capability.state !== 'ready'));
  const detail = disabled
    ? disabledLabel
    : needsAttention
      ? capability?.message ?? 'Record a shortcut to enable this action.'
      : `${capitalize(binding.triggerMode)} mode`;

  return (
    <div className="flex flex-col gap-3 border-b border-border py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <p className="text-sm font-medium">{binding.action === 'dictation' ? 'Dictation hotkey' : 'Agent hotkey'}</p>
        <p className={`text-xs ${needsAttention ? 'text-amber-300' : 'text-muted-foreground'}`}>
          {detail}
        </p>
      </div>
      <Button
        type="button"
        variant={needsAttention ? 'secondary' : 'outline'}
        disabled={disabled}
        onClick={onEdit}
        className="min-w-32 justify-center font-mono"
      >
        {binding.status === 'ready' && binding.accelerator ? (
          <ShortcutKeys accelerator={binding.accelerator} platform={platform} />
        ) : 'Record'}
      </Button>
    </div>
  );
}

function PlatformSetupNotice({ capabilities }: { capabilities: PlatformCapabilitiesSnapshot }) {
  const items = [
    {
      key: 'text-injection',
      label: 'Paste into other apps',
      state: capabilities.textInjection.state,
      message: capabilities.textInjection.message,
    },
    {
      key: 'dictation-shortcut',
      label: 'Dictation shortcut',
      state: capabilities.shortcuts.dictation.state,
      message: capabilities.shortcuts.dictation.message,
    },
    {
      key: 'agent-shortcut',
      label: 'Agent shortcut',
      state: capabilities.shortcuts.agent.state,
      message: capabilities.shortcuts.agent.message,
    },
  ].filter((item) => item.state !== 'ready');

  if (items.length === 0) return null;

  return (
    <div className="space-y-3 border-b border-border py-5">
      <div>
        <p className="text-sm font-medium">Platform setup</p>
        <p className="text-xs text-muted-foreground">{formatPlatformName(capabilities.platform, capabilities.desktop)}</p>
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.key} className="rounded-md border border-amber-400/25 bg-amber-400/5 px-3 py-2">
            <p className="text-xs font-medium text-amber-200">{item.label}</p>
            <p className="text-xs text-muted-foreground">{item.message}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatAccelerator(accelerator: string | null, platform: PlatformCapabilitiesSnapshot['platform'] = 'win32'): string {
  if (!accelerator) return '';
  return accelerator
    .split('+')
    .filter(Boolean)
    .map((part) => formatShortcutPart(part, platform))
    .join(' + ');
}

function ShortcutKeys({
  accelerator,
  platform = 'win32',
}: {
  accelerator: string;
  platform?: PlatformCapabilitiesSnapshot['platform'];
}) {
  return (
    <span className="inline-flex items-center gap-1">
      {accelerator.split('+').filter(Boolean).map((part, index, parts) => (
        <span key={`${part}-${index}`} className="inline-flex items-center gap-1">
          <ShortcutKeyPart part={part} platform={platform} />
          {index < parts.length - 1 ? <span className="text-muted-foreground/70">+</span> : null}
        </span>
      ))}
    </span>
  );
}

function ShortcutKeyPart({
  part,
  platform,
}: {
  part: string;
  platform: PlatformCapabilitiesSnapshot['platform'];
}) {
  if (part === 'Meta' && platform === 'win32') {
    return <WindowsIcon className="size-3.5 text-primary" aria-label="Windows" />;
  }

  return <span>{formatShortcutPart(part, platform)}</span>;
}

function formatShortcutPart(part: string, platform: PlatformCapabilitiesSnapshot['platform']): string {
  if (part === 'Meta') {
    if (platform === 'darwin') return '⌘';
    if (platform === 'linux') return 'Super';
    return 'Win';
  }
  if (part === 'Control') return platform === 'darwin' ? '⌃' : 'Ctrl';
  if (part === 'Alt') return platform === 'darwin' ? '⌥' : 'Alt';
  if (part === 'Shift') return platform === 'darwin' ? '⇧' : 'Shift';
  return part;
}

function formatPlatformName(platform: PlatformCapabilitiesSnapshot['platform'], desktop: string): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  return desktop;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function looksLikeRawApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_-]/.test(value.trim());
}

function isLocalProviderUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function DictionaryInput({
  dictionary,
  onChange,
}: {
  dictionary: string[];
  onChange: (value: string[]) => void;
}) {
  const [inputValue, setInputValue] = useState('');

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      const newWord = inputValue.trim();
      if (!dictionary.includes(newWord)) {
        onChange([...dictionary, newWord]);
      }
      setInputValue('');
    }
  };

  const removeWord = (wordToRemove: string) => {
    onChange(dictionary.filter(word => word !== wordToRemove));
  };

  return (
    <div className="space-y-3">
      <Input
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a word and press Enter..."
        className="w-full bg-background"
      />
      <div className="flex flex-wrap gap-2">
        {dictionary.map((word) => (
          <span
            key={word}
            className="group inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-sm font-medium text-secondary-foreground transition-all hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
          >
            {word}
            <button
              type="button"
              onClick={() => removeWord(word)}
              className="rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-destructive focus:ring-offset-1 focus:ring-offset-background"
            >
              <XIcon className="h-3 w-3" />
            </button>
          </span>
        ))}
        {dictionary.length === 0 && (
          <span className="text-xs text-muted-foreground italic px-1 py-1.5">No words added yet.</span>
        )}
      </div>
    </div>
  );
}
