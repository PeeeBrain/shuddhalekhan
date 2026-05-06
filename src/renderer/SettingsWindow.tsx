import { useEffect, useMemo, useState } from 'react';
import type { AppConfig, AppInfo, UpdateStatus } from '../types/ipc';

type SettingsSection = 'general' | 'audio' | 'agent' | 'mcp' | 'about';

const sections: Array<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'audio', label: 'Audio' },
  { id: 'agent', label: 'Agent' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'about', label: 'About' },
];

export function SettingsWindow() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [config, setConfigState] = useState<AppConfig | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle');

  useEffect(() => {
    window.electronAPI?.invoke('config:get').then(setConfigState).catch((err) => {
      console.error('Failed to load settings config:', err);
    });
    window.electronAPI?.invoke('app:get-info').then(setAppInfo).catch((err) => {
      console.error('Failed to load app info:', err);
    });
    window.electronAPI?.invoke('updater:get-status').then(setUpdateStatus).catch((err) => {
      console.error('Failed to load update status:', err);
    });

    return window.electronAPI?.on('updater:status-changed', setUpdateStatus);
  }, []);

  const updateConfig = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    setConfigState((current) => current ? { ...current, [key]: value } : current);
    window.electronAPI?.invoke('config:set', key, value);
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
      <main className="settings-shell loading">
        <p>Loading settings...</p>
      </main>
    );
  }

  return (
    <main className="settings-shell">
      <aside className="settings-rail" aria-label="Settings sections">
        <div className="settings-brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>Shuddhalekhan</h1>
            <p>{appInfo?.version ? `v${appInfo.version}` : 'Settings'}</p>
          </div>
        </div>

        <nav>
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={activeSection === section.id ? 'active' : ''}
              onClick={() => setActiveSection(section.id)}
            >
              {section.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="settings-content">
        <header className="settings-header">
          <div>
            <p className="eyebrow">Configuration</p>
            <h2>{sections.find((section) => section.id === activeSection)?.label}</h2>
          </div>
          <span className={`save-indicator ${saveState}`}>{saveState === 'saved' ? 'Saved' : 'Ready'}</span>
        </header>

        {activeSection === 'general' ? (
          <SettingsPanel>
            <ToggleRow
              title="Clean transcription"
              description="Remove common filler words before dictation text is injected."
              checked={config.removeFillerWords}
              onChange={(checked) => updateConfig('removeFillerWords', checked)}
            />
            <KeyRow label="Dictation hotkey" value="Ctrl + Win" />
            <KeyRow label="Agent hotkey" value="Alt + Win" />
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
            <ReadOnlyRow label="Selected device" value={config.selectedDeviceId ?? 'Default input device'} />
            <ReadOnlyRow label="Capture path" value="Shared by Dictation and Agent Mode" />
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
            <TextRow
              label="API key environment variable"
              value={config.agent.provider.apiKeyEnvVar}
              placeholder="OPENROUTER_API_KEY"
              onChange={(apiKeyEnvVar) => updateAgent({
                ...config.agent,
                provider: { ...config.agent.provider, apiKeyEnvVar },
              })}
            />
          </SettingsPanel>
        ) : null}

        {activeSection === 'mcp' ? (
          <SettingsPanel>
            <ReadOnlyRow label="Registry" value="Not implemented in Phase 3" />
            <ReadOnlyRow label="Gmail preset" value="Planned for a later phase" />
            <ReadOnlyRow label="Tool approvals" value="No tools are exposed yet" />
          </SettingsPanel>
        ) : null}

        {activeSection === 'about' ? (
          <SettingsPanel>
            <ReadOnlyRow label="Version" value={appInfo?.version ?? 'Unknown'} />
            <ReadOnlyRow label="Update status" value={statusText} />
            <button
              type="button"
              className="primary-action"
              disabled={updateStatus?.state === 'checking'}
              onClick={() => {
                window.electronAPI?.invoke('updater:check').then(setUpdateStatus).catch((err) => {
                  console.error('Failed to check for updates:', err);
                });
              }}
            >
              {updateStatus?.state === 'checking' ? 'Checking...' : 'Check for Updates'}
            </button>
          </SettingsPanel>
        ) : null}
      </section>
    </main>
  );
}

function SettingsPanel({ children }: { children: React.ReactNode }) {
  return <div className="settings-panel">{children}</div>;
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
    <label className={`setting-row toggle-row ${tone}`}>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function TextRow({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="setting-row input-row">
      <span>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="setting-row readonly-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function KeyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="setting-row key-row">
      <span>{label}</span>
      <kbd>{value}</kbd>
    </div>
  );
}
