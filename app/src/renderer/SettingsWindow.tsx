import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppConfig,
  AppInfo,
  McpServerRuntimeStatus,
  McpStatusSnapshot,
  UpdateStatus,
  VersionReleaseNotes,
} from '../types/ipc';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChevronDown, Search } from 'lucide-react';
import { createSettingsIpc } from './settings/settings-ipc';
import {
  DEFAULT_SETTINGS_SECTION,
  isFoldedSection,
  visibleNavGroups,
  type SettingsNavGroupId,
  type SettingsSectionId,
  type SettingsNavSection,
} from './settings/settings-nav';
import { isListboxNavKey, getNextListboxIndex } from './settings/audit-history-nav';
import { useSettingsPersistence } from './settings/use-settings-persistence';
import { SaveToast } from './settings/SaveToast';
import { CommandPalette } from './settings/CommandPalette';
import type { SettingsIpc } from './settings/settings-ipc';
import { Onboarding } from './settings/Onboarding';

type TabRefs = Partial<Record<SettingsSectionId, HTMLButtonElement | null>>;

interface SettingsWindowProps {
  settingsIpc?: SettingsIpc;
}

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
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** The user unfolding the Agent group while Agent Mode is off. */
  const [agentFoldOpen, setAgentFoldOpen] = useState(false);
  /** Run History opens on; null shows the newest. */
  const [historyRunId, setHistoryRunId] = useState<string | null>(null);
  const tabRefs = useRef<TabRefs>({});
  const latestMcpStatusRevision = useRef(-1);

  const applyConfig = useCallback((patch: Partial<AppConfig>) => {
    setConfigState((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const persistence = useSettingsPersistence(settingsIpc, applyConfig);
  const { onAgentConfigChanged } = persistence;

  useEffect(() => {
    const applyMcpStatusSnapshot = (snapshot: McpStatusSnapshot) => {
      if (snapshot.revision < latestMcpStatusRevision.current) return;
      latestMcpStatusRevision.current = snapshot.revision;
      setMcpStatuses(Object.fromEntries(
        snapshot.servers.map((status) => [status.serverId, status]),
      ));
    };

    // Main changes agent config on its own (discovered tools, imported skills).
    // Subscribe before the initial read: a push that lands first is newer than it.
    let pushedAgent: AppConfig['agent'] | null = null;
    const offAgentConfig = settingsIpc.onAgentConfigChanged((agent) => {
      pushedAgent = agent;
      onAgentConfigChanged(agent);
    });
    settingsIpc.getConfig().then((loaded) => {
      setConfigState((current) => current
        ?? (pushedAgent ? { ...loaded, agent: pushedAgent } : loaded));
    }).catch((err) => {
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
      const agentBeforeRead = pushedAgent;
      settingsIpc.getConfig().then((loaded) => {
        setConfigState((current) => pushedAgent !== agentBeforeRead && pushedAgent
          ? { ...loaded, agent: current?.agent ?? pushedAgent } : loaded);
      }).catch((error) => {
        console.error('Failed to reload completed onboarding config:', error);
      });
    });
    const handlePaletteShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', handlePaletteShortcut);

    return () => {
      window.removeEventListener('keydown', handlePaletteShortcut);
      offUpdater?.();
      offNavigate?.();
      offMcpSnapshot?.();
      offOnboarding?.();
      offAgentConfig?.();
    };
  }, [settingsIpc, onAgentConfigChanged]);

  if (!config) {
    return (
      <TitleBarFrame>
        <main className="settings-root flex h-full items-center justify-center bg-background text-foreground">
          <p className="text-muted-foreground">Loading settings…</p>
        </main>
      </TitleBarFrame>
    );
  }

  if (
    config.onboarding.status === 'pending'
    && config.transcription.activeProvider === 'managed-local'
    && !showAdvancedDuringOnboarding
  ) {
    return (
      <TitleBarFrame>
        <Onboarding config={config} settingsIpc={settingsIpc} onOpenAdvanced={() => setShowAdvancedDuringOnboarding(true)} />
      </TitleBarFrame>
    );
  }

  // The Agent group is open while Agent Mode is on or its page is showing, so a deep link never lands in a folded section.
  const agentLocked = config.agent.enabled || isFoldedSection(activeSection);
  const agentExpanded = agentLocked || agentFoldOpen;
  const navGroups = visibleNavGroups({ agentExpanded });
  const navSections = navGroups.flatMap<SettingsNavSection>((group) => group.sections);

  const selectSection = (id: SettingsSectionId) => {
    setActiveSection(id);
    setHistoryRunId(null);
    tabRefs.current[id]?.focus();
  };

  const openRun = (agentRunId: string) => {
    selectSection('history');
    setHistoryRunId(agentRunId);
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!isListboxNavKey(event.key)) return;
    event.preventDefault();
    const currentIndex = navSections.findIndex((section) => section.id === activeSection);
    const nextIndex = getNextListboxIndex(currentIndex, event.key, navSections.length);
    const next = navSections[nextIndex];
    if (next) selectSection(next.id);
  };

  const sectionProps = {
    onOpenRun: openRun,
    initialRunId: historyRunId,
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

  const active = navSections.find((section) => section.id === activeSection)!;
  const Section = active.component;

  return (
    <main className="settings-root relative flex h-full overflow-hidden bg-background text-foreground">
      <aside
        inert={paletteOpen}
        className="flex w-52 shrink-0 flex-col border-r border-border/60 bg-canvas"
        aria-label="Settings sections"
      >
        {/* The header doubles as this column's drag strip, so the sidebar color reaches the window top. */}
        <div className="flex h-20 shrink-0 flex-col justify-center px-5 [-webkit-app-region:drag]">
          <p className="text-sm font-semibold tracking-tight">Shuddhalekhan</p>
          <p className="text-xs text-muted-foreground">
            Settings{appInfo?.version ? ` · v${appInfo.version}` : ''}
          </p>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-5">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="settings-nav-item mb-5 border border-border/60"
          >
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <span className="flex-1 text-left">Search</span>
            <kbd className="text-[10px] font-normal text-muted-foreground">Ctrl K</kbd>
          </button>

          <nav className="flex flex-1 flex-col gap-5" aria-label="Settings navigation">
            {navGroups.map((group) => (
              <NavGroup
                key={group.id}
                group={group}
                activeSection={activeSection}
                tabRefs={tabRefs}
                fold={group.id === 'agent' && !agentLocked
                  ? { open: agentExpanded, onToggle: () => setAgentFoldOpen((open) => !open) }
                  : undefined}
                onSelect={selectSection}
                onKeyDown={handleTabKeyDown}
              />
            ))}
          </nav>
        </div>
      </aside>

      <section inert={paletteOpen} className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <div className="title-bar-drag" aria-hidden="true" />
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
                title="Agent History"
                description="Review past agent runs, tool activity, and responses."
              />
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-10 pb-8">
                <Section key={historyRunId ?? 'latest'} {...sectionProps} />
              </div>
            </div>
          ) : (
            <ScrollArea className="h-full min-h-0 flex-1">
              <div className="mx-auto w-full max-w-3xl px-10 py-9">
                <Section {...sectionProps} />
              </div>
            </ScrollArea>
          )}
        </div>
        <SaveToast toast={persistence.toast} />
      </section>
      {paletteOpen ? (
        <CommandPalette
          settingsIpc={settingsIpc}
          onClose={() => setPaletteOpen(false)}
          onNavigate={selectSection}
          onOpenRun={openRun}
        />
      ) : null}
    </main>
  );
}

interface NavGroupProps {
  group: {
    id: SettingsNavGroupId;
    label: string;
    sections: readonly SettingsNavSection[];
  };
  activeSection: SettingsSectionId;
  tabRefs: React.MutableRefObject<TabRefs>;
  /** Present when the group's heading can fold its detail pages away. */
  fold?: { open: boolean; onToggle: () => void };
  onSelect: (id: SettingsSectionId) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}

/** Full-width drag strip above a single-column screen (loading, onboarding). */
function TitleBarFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="title-bar-drag" aria-hidden="true" />
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function NavGroup({
  group,
  activeSection,
  tabRefs,
  fold,
  onSelect,
  onKeyDown,
}: NavGroupProps) {
  return (
    <div className={group.id === 'system' ? 'mt-auto' : undefined}>
      {fold ? (
        <button
          type="button"
          id={`settings-group-${group.id}`}
          aria-expanded={fold.open}
          aria-controls={`settings-group-tabs-${group.id}`}
          onClick={fold.onToggle}
          className="mb-1 flex w-full items-center justify-between px-2.5 text-[11px] font-medium text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {group.label}
          <ChevronDown
            aria-hidden="true"
            className={`size-3 shrink-0 transition-transform ${fold.open ? 'rotate-180' : ''}`}
          />
        </button>
      ) : (
        <p
          id={`settings-group-${group.id}`}
          className="mb-1 px-2.5 text-[11px] font-medium text-muted-foreground/70"
        >
          {group.label}
        </p>
      )}
      <div
        id={`settings-group-tabs-${group.id}`}
        role="tablist"
        aria-orientation="vertical"
        aria-label={group.label}
        className="flex flex-col gap-0.5"
      >
        {group.sections.map((section) => {
          const isActive = activeSection === section.id;
          const Icon = section.icon;
          return (
            <button
              key={section.id}
              ref={(el) => {
                tabRefs.current[section.id] = el;
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
    <header className="flex shrink-0 items-start justify-between gap-6 px-10 pb-6 pt-9">
      <div>
        <h2
          id={`section-heading-${sectionId}`}
          className="text-xl font-semibold tracking-tight"
        >
          {title}
        </h2>
        <p className="mt-1 max-w-xl text-[13px] leading-5 text-muted-foreground">{description}</p>
      </div>
    </header>
  );
}
