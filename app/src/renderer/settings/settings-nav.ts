export type SettingsSectionId =
  | 'home'
  | 'transcription'
  | 'shortcuts'
  | 'agent'
  | 'mcp'
  | 'skills'
  | 'memory'
  | 'history'
  | 'about';

export type SettingsNavGroupId = 'general' | 'agent' | 'system';

export interface SettingsNavSection {
  id: SettingsSectionId;
  label: string;
  group: SettingsNavGroupId;
}

export interface SettingsNavGroup {
  id: SettingsNavGroupId;
  label: string;
  sections: SettingsNavSection[];
}

export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    id: 'general',
    label: 'General',
    sections: [
      { id: 'home', label: 'Home', group: 'general' },
      { id: 'transcription', label: 'Transcription', group: 'general' },
      { id: 'shortcuts', label: 'Shortcuts', group: 'general' },
    ],
  },
  {
    id: 'agent',
    label: 'Agent',
    sections: [
      { id: 'agent', label: 'Agent', group: 'agent' },
      { id: 'mcp', label: 'MCP Servers', group: 'agent' },
      { id: 'skills', label: 'Skills', group: 'agent' },
      { id: 'memory', label: 'Memory', group: 'agent' },
      { id: 'history', label: 'History', group: 'agent' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    sections: [{ id: 'about', label: 'About', group: 'system' }],
  },
];

export const SETTINGS_NAV_SECTIONS: SettingsNavSection[] =
  SETTINGS_NAV_GROUPS.flatMap((group) => group.sections);

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
