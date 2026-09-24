import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppConfig,
  AppInfo,
  McpServerConfig,
  McpServerRuntimeStatus,
  McpStatusSnapshot,
  UpdateStatus,
  VersionReleaseNotes,
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
} from 'lucide-react';import { createSettingsIpc } from './settings/settings-ipc';
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
import { Onboarding } from './settings/Onboarding';

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
  const [showAdvancedDuringOnboarding, setShowAdvancedDuringOnboarding] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [bundledReleaseNotes, setBundledReleaseNotes] =
    useState<VersionReleaseNotes | null>(null);
  const [mcpStatuses, setMcpStatuses] = useState<
    Record<string, McpServerRuntimeStatus>
  >({});
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const latestMcpStatusRevision = useRef(-1);

  useEffect(() => {
    const applyMcpStatusSnapshot = (snapshot: McpStatusSnapshot) => {
      if (snapshot.revision < latestMcpStatusRevision.current) return;
      latestMcpStatusRevision.current = snapshot.revision;
      setMcpStatuses(Object.fromEntries(
        snapshot.servers.map((status) => [status.serverId, status]),
      ));
    };

    settingsIpc.getConfig().then(setConfigState).catch((err) => {
      console.error('Failed to load settings config:', err);
    });
    settingsIpc.getAppInfo().then(setAppInfo).catch((err) => {
      console.error('Failed to load app info:', err);
    });
    settingsIpc.getUpdateStatus().then(setUpdateStatus).catch((err) => {
      console.error('Failed to load update status:', err);
    });
    settingsIpc.getReleaseNotes().then(setBundledReleaseNotes).catch((err) => {
      console.error('Failed to load release notes:', err);
    });
    const offMcpSnapshot = settingsIpc.onMcpStatusSnapshot(applyMcpStatusSnapshot);
    settingsIpc.getMcpStatusSnapshot().then(applyMcpStatusSnapshot).catch((err) => {
      console.error('Failed to load MCP status:', err);
    });

    const offUpdater = settingsIpc.onUpdateStatusChanged(setUpdateStatus);
    const offNavigate = settingsIpc.onNavigateRequested((section) => {
      setActiveSection(section);
    });
    const offOnboarding = settingsIpc.onOnboardingCompleted(() => {
      setConfigState((current) => current ? {
        ...current,
        onboarding: { status: 'complete' },
        setupChecklistDismissed: true,
      } : current);
    });

    return () => {
      offUpdater?.();
      offNavigate?.();
      offMcpSnapshot?.();
      offOnboarding?.();
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

  if (
    config.onboarding.status === 'pending'
    && config.transcription.activeProvider === 'managed-local'
    && !showAdvancedDuringOnboarding
  ) {
    return <Onboarding config={config} settingsIpc={settingsIpc} onOpenAdvanced={() => setShowAdvancedDuringOnboarding(true)} />;
  }

  const selectSection = (id: SettingsSectionId) => {
    setActiveSection(id);
    tabRefs.current[getNavSectionIndex(id)]?.focus();
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
    bundledReleaseNotes,
    mcpStatuses,
    settingsIpc,
    persistence,
    onNavigate: selectSection,
    onUpdateStatusChange: setUpdateStatus,
  };

  return (
    <main className="settings-root relative flex h-screen overflow-hidden bg-background text-foreground">
      <aside
        className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border/60 bg-background px-3 py-5"
        aria-label="Settings sections"
      >
        <div className="mb-6 px-2.5">
          <p className="text-[11px] font-medium text-muted-foreground">Settings</p>
        </div>

        <nav className="flex flex-col gap-6" aria-label="Settings navigation">
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

      <section className="relative flex h-screen min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <div
          key={activeSection}
          role="tabpanel"
          id={`panel-${activeSection}`}
          aria-labelledby={`tab-${activeSection}`}
          tabIndex={0}
          className="content-enter flex min-h-0 flex-1 flex-col overflow-hidden focus:outline-none"
        >
          {activeSection === 'history' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <SectionFrame
                sectionId="history"
                title="History"
                description="Review past agent runs, tool activity, and responses."
              />
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-8 pb-8">
                <AuditHistorySettings settingsIpc={settingsIpc} />
              </div>
            </div>
          ) : (
            <ScrollArea className="h-full min-h-0 flex-1">
              <div className="mx-auto w-full max-w-4xl px-8 py-8">
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
        className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"
      >
        {group.label}
      </p>
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label={group.label}
        className="flex flex-col gap-1"
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
              data-active={isActive}
              className={`settings-nav-item ${
                isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => onSelect(section.id)}
              onKeyDown={onKeyDown}
            >
              <Icon className={`size-4 shrink-0 ${isActive ? 'text-primary' : ''}`} aria-hidden="true" />
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
    <header className="flex shrink-0 items-start justify-between gap-6 px-8 pb-5 pt-7">
      <div>
        <h2
          id={`section-heading-${sectionId}`}
          className="text-2xl font-semibold tracking-tight"
        >
          {title}
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
    </header>
  );
}
