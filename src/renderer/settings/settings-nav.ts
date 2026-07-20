export type SettingsSectionId =
  | 'transcription'
  | 'audio'
  | 'shortcuts'
  | 'agent'
  | 'mcp'
  | 'history'
  | 'about';

export type SettingsNavGroupId = 'dictation' | 'agent' | 'system';

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
    id: 'dictation',
    label: 'Dictation',
    sections: [
      { id: 'transcription', label: 'Transcription', group: 'dictation' },
      { id: 'audio', label: 'Audio', group: 'dictation' },
      { id: 'shortcuts', label: 'Shortcuts', group: 'dictation' },
    ],
  },
  {
    id: 'agent',
    label: 'Agent',
    sections: [
      { id: 'agent', label: 'Agent', group: 'agent' },
      { id: 'mcp', label: 'MCP Servers', group: 'agent' },
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

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'transcription';

export function findNavSection(
  id: SettingsSectionId,
): SettingsNavSection | undefined {
  return SETTINGS_NAV_SECTIONS.find((section) => section.id === id);
}

export function getNavSectionIndex(id: SettingsSectionId): number {
  const index = SETTINGS_NAV_SECTIONS.findIndex(
    (section) => section.id === id,
  );
  return index === -1 ? 0 : index;
}