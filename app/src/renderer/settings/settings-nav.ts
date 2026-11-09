import { createElement, type ComponentType } from 'react';
import { BookOpen, Bot, Brain, FileText, History, House, Info, Keyboard, Plug } from 'lucide-react';
import { HomeSettings } from './HomeSettings';
import { TranscriptionSettings } from './TranscriptionSettings';
import { ShortcutsSettings } from './ShortcutsSettings';
import { AgentSettings } from './AgentSettings';
import { McpSettings } from './McpSettings';
import { SkillsSettings } from './SkillsSettings';
import { MemorySettings } from './MemorySettings';
import { AuditHistorySettings } from './AuditHistorySettings';
import { AboutSettings } from './AboutSettings';
import type { SettingsSectionProps } from './settings-section-props';

export interface SettingsPageProps extends SettingsSectionProps {
  onOpenRun: (id: string) => void;
  initialRunId: string | null;
}

function McpPage(props: SettingsPageProps) {
  return createElement(McpSettings, {
    servers: props.config.agent.mcpServers,
    statuses: props.mcpStatuses,
    agentEnabled: props.config.agent.enabled,
    saveError: props.persistence.fieldErrors['mcp-servers'],
    onChange: (mcpServers) => { void props.persistence.commit('agent', { ...props.config.agent, mcpServers }, 'mcp-servers'); },
    onTest: props.settingsIpc.testMcpServer,
  });
}

export const SETTINGS_NAV_GROUPS = [
  {
    id: 'general',
    label: 'General',
    sections: [
      { id: 'home', label: 'Home', icon: House, component: HomeSettings },
      { id: 'transcription', label: 'Transcription', icon: FileText, component: TranscriptionSettings },
      { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, component: ShortcutsSettings },
    ],
  },
  {
    id: 'agent',
    label: 'Agent',
    sections: [
      { id: 'agent', label: 'Agent', icon: Bot, component: AgentSettings },
      { id: 'mcp', label: 'MCP Servers', icon: Plug, component: McpPage },
      { id: 'skills', label: 'Skills', icon: BookOpen, component: SkillsSettings },
      { id: 'memory', label: 'Memory', icon: Brain, component: MemorySettings },
      { id: 'history', label: 'History', icon: History, component: AuditHistorySettings },
    ],
  },
  {
    id: 'system',
    label: 'System',
    sections: [{ id: 'about', label: 'About', icon: Info, component: AboutSettings }],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  sections: ReadonlyArray<{ id: string; label: string; icon: typeof House; component: ComponentType<SettingsPageProps> }>;
}>;

export type SettingsNavGroupId = typeof SETTINGS_NAV_GROUPS[number]['id'];
export type SettingsNavSection = typeof SETTINGS_NAV_GROUPS[number]['sections'][number];
export type SettingsSectionId = SettingsNavSection['id'];

export const SETTINGS_NAV_SECTIONS: readonly SettingsNavSection[] =
  SETTINGS_NAV_GROUPS.flatMap<SettingsNavSection>((group) => group.sections);

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'home';

export function getNavSectionIndex(id: SettingsSectionId): number {
  const index = SETTINGS_NAV_SECTIONS.findIndex(
    (section) => section.id === id,
  );
  return index === -1 ? 0 : index;
}

/** Command palette entries: settings sections and agent runs. */
export type PaletteItem =
  | { kind: 'section'; id: SettingsSectionId; label: string }
  | { kind: 'run'; id: string; label: string; meta: string };

/** Sections first, then agent runs; every word in the query must appear. */
export function matchPaletteItems(items: PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const text = `${item.label} ${item.kind === 'run' ? item.meta : ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
