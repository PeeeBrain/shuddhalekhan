import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppConfig,
  AppInfo,
  McpServerConfig,
  McpServerRuntimeStatus,
  UpdateStatus,
} from '../types/ipc';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Bot,
  FileText,
  History as HistoryIcon,
  Info,
  Keyboard,
  Mic,
  Plug,
} from 'lucide-react';
import { createSettingsIpc } from './settings/settings-ipc';
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_SECTIONS,
  getNavSectionIndex,
  type SettingsNavGroupId,
  type SettingsSectionId,
} from './settings/settings-nav';
import { isListboxNavKey, getNextListboxIndex } from './settings/audit-history-nav';
import { useSettingsPersistence } from './settings/use-settings-persistence';
import { SaveToast } from './settings/SaveToast';
import { TranscriptionSettings } from './settings/TranscriptionSettings';
import { AudioSettings } from './settings/AudioSettings';
import { ShortcutsSettings } from './settings/ShortcutsSettings';
import { AgentSettings } from './settings/AgentSettings';
import { AboutSettings } from './settings/AboutSettings';
import { McpSettings } from './settings/McpSettings';
import { AuditHistorySettings } from './settings/AuditHistorySettings';
import type { SettingsIpc } from './settings/settings-ipc';

interface SettingsWindowProps {
  settingsIpc?: SettingsIpc;
}

const NAV_ICONS: Record<SettingsSectionId, React.ElementType> = {
  transcription: FileText,
  audio: Mic,
  shortcuts: Keyboard,
  agent: Bot,
  mcp: Plug,
  history: HistoryIcon,
  about: Info,
};

export function SettingsWindow({ settingsIpc: provided }: SettingsWindowProps = {}) {
  const settingsIpc = useMemo(
    () => provided ?? createSettingsIpc(window.electronAPI),
    [provided],
  );
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(
    DEFAULT_SETTINGS_SECTION,
  );
  const [config, setConfigState] = useState<AppConfig | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [mcpStatuses, setMcpStatuses] = useState<
    Record<string, McpServerRuntimeStatus>
  >({});
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

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

  const applyOptimistic = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    setConfigState((current) => (current ? { ...current, [key]: value } : current));
  };

  const persistence = useSettingsPersistence(settingsIpc, applyOptimistic);

  if (!config) {
    return (
      <main className="settings-root flex h-screen items-center justify-center bg-background text-foreground">
        <p className="text-muted-foreground">Loading settings...</p>
      </main>
    );
  }

  const selectSection = (id: SettingsSectionId) => {
    setActiveSection(id);
    const index = getNavSectionIndex(id);
    requestAnimationFrame(() => {
      tabRefs.current[index]?.focus();
    });
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!isListboxNavKey(event.key)) return;
    event.preventDefault();
    const currentIndex = getNavSectionIndex(activeSection);
    const nextIndex = getNextListboxIndex(currentIndex, event.key, SETTINGS_NAV_SECTIONS.length);
    const next = SETTINGS_NAV_SECTIONS[nextIndex];
    if (next) selectSection(next.id);
  };

  const updateMcpServers = (mcpServers: McpServerConfig[]) =>
    persistence.commit('agent', { ...config.agent, mcpServers }, 'mcp-servers');

  const sectionProps = {
    config,
    appInfo,
    updateStatus,
    mcpStatuses,
    settingsIpc,
    persistence,
    onNavigate: selectSection,
    onUpdateStatusChange: setUpdateStatus,
  };

  return (
    <main className="settings-root relative flex h-screen bg-background text-foreground">
      <aside
        className="flex w-56 shrink-0 flex-col border-r border-border bg-background p-5 pt-6"
        aria-label="Settings sections"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary">
            <span className="text-lg font-bold leading-none text-primary">S</span>
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Shuddhalekhan</h1>
            <p className="text-xs text-muted-foreground">
              {appInfo?.version ? `v${appInfo.version}` : 'Settings'}
            </p>
          </div>
        </div>

        <nav className="flex flex-col gap-4" aria-label="Settings navigation">
          {SETTINGS_NAV_GROUPS.map((group) => (
            <NavGroup
              key={group.id}
              group={group}
              activeSection={activeSection}
              tabRefs={tabRefs}
              onSelect={selectSection}
              onKeyDown={handleTabKeyDown}
            />
          ))}
        </nav>
      </aside>

      <section className="relative flex h-screen min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
        <div
          key={activeSection}
          role="tabpanel"
          id={`panel-${activeSection}`}
          aria-labelledby={`tab-${activeSection}`}
          tabIndex={0}
          className="content-enter flex min-h-0 flex-1 flex-col overflow-hidden focus:outline-none"
        >
          {activeSection === 'history' ? (
            <div className="flex flex-1 flex-col min-h-0">
              <SectionFrame
                sectionId="history"
                title="History"
                description="Review past agent runs, tool activity, and responses."
              />
              <div className="flex flex-1 min-h-0 flex-col overflow-hidden px-10 pb-8">
                <AuditHistorySettings settingsIpc={settingsIpc} />
              </div>
            </div>
          ) : (
            <ScrollArea className="h-full min-h-0 flex-1">
              <div className="px-10 py-8">
                {activeSection === 'transcription' ? (
                  <TranscriptionSettings {...sectionProps} />
                ) : null}
                {activeSection === 'audio' ? (
                  <AudioSettings {...sectionProps} />
                ) : null}
                {activeSection === 'shortcuts' ? (
                  <ShortcutsSettings {...sectionProps} />
                ) : null}
                {activeSection === 'agent' ? (
                  <AgentSettings {...sectionProps} />
                ) : null}
                {activeSection === 'mcp' ? (
                  <McpSettings
                    servers={config.agent.mcpServers}
                    statuses={mcpStatuses}
                    saveError={persistence.fieldErrors['mcp-servers']}
                    onChange={updateMcpServers}
                    onTest={(serverId) => {
                      settingsIpc.testMcpServer(serverId);
                    }}
                  />
                ) : null}
                {activeSection === 'about' ? (
                  <AboutSettings {...sectionProps} />
                ) : null}
              </div>
            </ScrollArea>
          )}
        </div>
        <SaveToast toast={persistence.toast} />
      </section>
    </main>
  );
}

interface NavGroupProps {
  group: {
    id: SettingsNavGroupId;
    label: string;
    sections: Array<{ id: SettingsSectionId; label: string }>;
  };
  activeSection: SettingsSectionId;
  tabRefs: React.MutableRefObject<Array<HTMLButtonElement | null>>;
  onSelect: (id: SettingsSectionId) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}

function NavGroup({
  group,
  activeSection,
  tabRefs,
  onSelect,
  onKeyDown,
}: NavGroupProps) {
  return (
    <div>
      <p
        id={`settings-group-${group.id}`}
        className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {group.label}
      </p>
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label={group.label}
        className="flex flex-col gap-0.5"
      >
        {group.sections.map((section) => {
          const isActive = activeSection === section.id;
          const index = getNavSectionIndex(section.id);
          const Icon = NAV_ICONS[section.id];
          return (
            <button
              key={section.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${section.id}`}
              aria-selected={isActive}
              aria-controls={`panel-${section.id}`}
              tabIndex={isActive ? 0 : -1}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                isActive
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              }`}
              onClick={() => onSelect(section.id)}
              onKeyDown={onKeyDown}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {section.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SectionFrame({
  sectionId,
  title,
  description,
}: {
  sectionId: SettingsSectionId;
  title: string;
  description: string;
}) {
  return (
    <header className="flex shrink-0 items-start justify-between gap-6 px-10 pt-8 pb-0">
      <div>
        <h2
          id={`section-heading-${sectionId}`}
          className="text-xl font-semibold tracking-tight"
        >
          {title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </header>
  );
}
