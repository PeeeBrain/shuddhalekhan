import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SkillsSettings } from '../SkillsSettings';
import type { SettingsIpc } from '../settings-ipc';
import type { SettingsSectionProps } from '../settings-section-props';
import type { AgentSkillSummary } from '../../../shared/agent-context';
import type { AppConfig } from '../../../types/ipc';

afterEach(cleanup);

const skill = (name: string, patch: Partial<AgentSkillSummary> = {}): AgentSkillSummary => ({
  name,
  description: `Use for ${name}.`,
  enabled: true,
  error: null,
  ...patch,
});

/** Renders against an in-memory skills folder; config commits re-render like the real window. */
async function renderSkills(initial: AgentSkillSummary[] = [], ipc: Partial<SettingsIpc> = {}) {
  let skills = initial;
  let agent = { enabled: false, provider: {}, mcpServers: [] } as unknown as AppConfig['agent'];
  const settingsIpc = {
    listSkills: mock(() => Promise.resolve(skills)),
    readSkill: mock((name: string) => Promise.resolve({ name, content: `---\nname: ${name}\nlicense: MIT\n---\n\nOld` })),
    saveSkill: mock(({ name }: { name: string }) => {
      skills = [...skills.filter((item) => item.name !== name), skill(name)];
      return Promise.resolve(skills);
    }),
    selectSkillImport: mock(() => Promise.resolve({ token: 't1', name: 'pdf', description: 'Fill PDF forms.' })),
    importSkill: mock(() => {
      skills = [...skills, skill('pdf', { enabled: false })];
      return Promise.resolve(skills);
    }),
    removeSkill: mock((name: string) => {
      skills = skills.filter((item) => item.name !== name);
      return Promise.resolve(skills);
    }),
    openSkillsFolder: mock(() => Promise.resolve()),
    ...ipc,
  };
  const commit = mock(async (_key: 'agent', value: AppConfig['agent']) => {
    agent = value;
    skills = skills.map((item) => ({ ...item, enabled: !value.disabledSkills?.includes(item.name) }));
    view.rerender(<SkillsSettings {...props()} />);
  });
  const props = () => ({
    config: { agent } as AppConfig,
    persistence: { commit, fieldErrors: {}, clearFieldError: () => undefined, toast: null },
    settingsIpc: settingsIpc as unknown as SettingsIpc,
  }) as unknown as SettingsSectionProps;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<SkillsSettings {...props()} />);
  });
  return { settingsIpc, commit, agent: () => agent };
}

const click = (element: HTMLElement) => act(async () => { fireEvent.click(element); });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('SkillsSettings', () => {
  it('creates a skill with generated frontmatter from simple fields', async () => {
    const { settingsIpc } = await renderSkills();
    expect(screen.getByText(/No skills yet/)).toBeInTheDocument();

    await click(screen.getByRole('button', { name: 'Create skill' }));
    type('Name', 'email-style');
    type('When to use it', 'Use when "replying" to email.');
    type('Instructions', 'Be brief.');
    await click(screen.getByRole('button', { name: 'Save skill' }));

    expect(settingsIpc.saveSkill).toHaveBeenCalledWith({
      name: 'email-style',
      content: '---\nname: "email-style"\ndescription: "Use when \\"replying\\" to email."\n---\n\nBe brief.\n',
      create: true,
    });
    expect(screen.queryByRole('form', { name: 'Create skill' })).toBeNull();
    expect(screen.getByText('email-style')).toBeInTheDocument();
  });

  it('keeps the draft and shows the main error when saving fails', async () => {
    await renderSkills([], {
      saveSkill: mock(() => Promise.reject(new Error("Error invoking remote method 'skills:save': Error: A skill named email-style already exists."))),
    });

    await click(screen.getByRole('button', { name: 'Create skill' }));
    type('Name', 'email-style');
    type('When to use it', 'Email');
    type('Instructions', 'Be brief.');
    await click(screen.getByRole('button', { name: 'Save skill' }));

    expect(screen.getByRole('alert')).toHaveTextContent('A skill named email-style already exists.');
    expect(screen.getByLabelText('Instructions')).toHaveValue('Be brief.');
  });

  it('edits the raw SKILL.md so optional frontmatter survives', async () => {
    const { settingsIpc } = await renderSkills([skill('pdf')]);

    await click(screen.getByRole('button', { name: 'Edit pdf' }));
    const editor = screen.getByLabelText('SKILL.md');
    expect(editor).toHaveValue('---\nname: pdf\nlicense: MIT\n---\n\nOld');
    fireEvent.change(editor, { target: { value: '---\nname: pdf\nlicense: MIT\n---\n\nNew' } });
    await click(screen.getByRole('button', { name: 'Save skill' }));

    expect(settingsIpc.saveSkill).toHaveBeenCalledWith({
      name: 'pdf',
      content: '---\nname: pdf\nlicense: MIT\n---\n\nNew',
      create: false,
    });
  });

  it('shows the parsed name and description before importing, and the import starts disabled', async () => {
    const { settingsIpc, agent } = await renderSkills();

    await click(screen.getByRole('button', { name: 'Import skill' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Import "pdf"?' });
    expect(dialog).toHaveTextContent('Fill PDF forms.');
    expect(settingsIpc.importSkill).not.toHaveBeenCalled();

    await click(within(dialog).getByRole('button', { name: 'Import' }));

    expect(settingsIpc.importSkill).toHaveBeenCalledWith('t1');
    expect(agent().disabledSkills).toEqual(['pdf']);
    expect(screen.getByRole('switch', { name: 'Enable pdf' })).not.toBeChecked();
  });

  it('does nothing when the folder picker is cancelled', async () => {
    const { settingsIpc } = await renderSkills([], { selectSkillImport: mock(() => Promise.resolve(null)) });

    await click(screen.getByRole('button', { name: 'Import skill' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(settingsIpc.importSkill).not.toHaveBeenCalled();
  });

  it('toggles a skill through config and reloads the list', async () => {
    const { settingsIpc, agent } = await renderSkills([skill('pdf'), skill('email', { enabled: false })]);

    await click(screen.getByRole('switch', { name: 'Enable pdf' }));

    expect(agent().disabledSkills).toEqual(['pdf', 'email']);
    await waitFor(() => expect(settingsIpc.listSkills).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('switch', { name: 'Enable pdf' })).not.toBeChecked();
  });

  it('confirms before removing the app-owned copy', async () => {
    const { settingsIpc } = await renderSkills([skill('pdf')]);

    await click(screen.getByRole('button', { name: 'Remove pdf' }));
    expect(settingsIpc.removeSkill).not.toHaveBeenCalled();
    await click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));

    expect(settingsIpc.removeSkill).toHaveBeenCalledWith('pdf');
    expect(screen.getByText(/No skills yet/)).toBeInTheDocument();
  });

  it('shows invalid skills with an actionable error and cannot enable them', async () => {
    await renderSkills([skill('broken', { description: '', error: 'SKILL.md is missing a description.' })]);

    expect(screen.getByText(/SKILL.md is missing a description\. Edit the skill/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable broken' })).toBeDisabled();
  });
});
