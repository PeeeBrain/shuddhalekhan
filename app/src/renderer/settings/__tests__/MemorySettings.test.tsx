import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemorySettings } from '../MemorySettings';
import type { SettingsIpc } from '../settings-ipc';
import type { SettingsSectionProps } from '../settings-section-props';
import type { AgentMemorySnapshot } from '../../../shared/agent-context';
import type { AppConfig } from '../../../types/ipc';

afterEach(cleanup);

const snapshot = (revision: string, texts: string[], patch: Partial<AgentMemorySnapshot> = {}): AgentMemorySnapshot => ({
  revision,
  markdown: '',
  facts: texts.map((text) => ({ id: `id-${text}`, text })),
  status: null,
  error: null,
  ...patch,
});

async function renderMemory(initial: AgentMemorySnapshot, ipc: Partial<SettingsIpc> = {}) {
  let push: (next: AgentMemorySnapshot) => void = () => undefined;
  const off = mock(() => undefined);
  const settingsIpc = {
    getMemory: mock(() => Promise.resolve(initial)),
    editMemoryFact: mock((_revision: string, _id: string, text: string) => Promise.resolve(snapshot('r2', [text]))),
    removeMemoryFact: mock(() => Promise.resolve(snapshot('r2', []))),
    clearMemory: mock(() => Promise.resolve(snapshot('r2', []))),
    onMemoryChanged: mock((callback: (next: AgentMemorySnapshot) => void) => {
      push = callback;
      return off;
    }),
    ...ipc,
  };
  const commit = mock(() => Promise.resolve());
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <MemorySettings
        {...({
          config: { agent: { enabled: false, mcpServers: [] } } as unknown as AppConfig,
          persistence: { commit, fieldErrors: {}, clearFieldError: () => undefined, toast: null },
          settingsIpc: settingsIpc as unknown as SettingsIpc,
        } as unknown as SettingsSectionProps)}
      />,
    );
  });
  return { settingsIpc, commit, off, view, push: (next: AgentMemorySnapshot) => act(async () => push(next)) };
}

const click = (element: HTMLElement) => act(async () => { fireEvent.click(element); });

describe('MemorySettings', () => {
  it('allows an explicitly confirmed clear to recover a malformed memory file', async () => {
    const { settingsIpc } = await renderMemory(snapshot('r1', [], { error: 'Memory must contain one fact per Markdown bullet.' }));
    await click(screen.getByRole('button', { name: 'Clear memory' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Clear memory?' });
    await click(within(dialog).getByRole('button', { name: 'Clear memory' }));
    expect(settingsIpc.clearMemory).toHaveBeenCalledWith('r1');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('defaults off and commits the toggle into agent config', async () => {
    const { commit } = await renderMemory(snapshot('r1', []));

    const toggle = screen.getByRole('switch', { name: 'Enable memory' });
    expect(toggle).not.toBeChecked();
    await click(toggle);

    expect(commit).toHaveBeenCalledWith('agent', { enabled: false, mcpServers: [], memoryEnabled: true }, 'agent-memory-enabled');
  });

  it('saves an edited fact against the revision it was read at', async () => {
    const { settingsIpc } = await renderMemory(snapshot('r1', ['Prefers tea']));

    fireEvent.change(screen.getByRole('textbox', { name: 'Fact 1' }), { target: { value: 'Prefers green tea' } });
    await click(screen.getByRole('button', { name: 'Save' }));

    expect(settingsIpc.editMemoryFact).toHaveBeenCalledWith('r1', 'id-Prefers tea', 'Prefers green tea');
    expect(screen.getByRole('textbox', { name: 'Fact 1' })).toHaveValue('Prefers green tea');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('keeps the draft and reloads after a stale or failed save', async () => {
    const getMemory = mock(() => Promise.resolve(snapshot('r1', ['Prefers tea'])));
    const { settingsIpc } = await renderMemory(snapshot('r1', ['Prefers tea']), {
      getMemory,
      editMemoryFact: mock(() => Promise.reject(new Error("Error invoking remote method 'memory:edit': Error: Memory changed. Review it and try again."))),
    });

    fireEvent.change(screen.getByRole('textbox', { name: 'Fact 1' }), { target: { value: 'Prefers green tea' } });
    await click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Memory changed. Review it and try again.');
    expect(screen.getByRole('textbox', { name: 'Fact 1' })).toHaveValue('Prefers green tea');
    expect(settingsIpc.getMemory).toHaveBeenCalledTimes(2);
  });

  it('deletes a single fact', async () => {
    const { settingsIpc } = await renderMemory(snapshot('r1', ['Prefers tea']));

    await click(screen.getByRole('button', { name: 'Delete fact 1' }));

    expect(settingsIpc.removeMemoryFact).toHaveBeenCalledWith('r1', 'id-Prefers tea');
    expect(screen.getByText('No saved facts yet.')).toBeInTheDocument();
  });

  it('confirms before clearing and explains that History is kept', async () => {
    const { settingsIpc } = await renderMemory(snapshot('r1', ['Prefers tea']));

    await click(screen.getByRole('button', { name: 'Clear memory' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Clear memory?' });
    expect(dialog).toHaveTextContent('History of past agent runs is kept');
    expect(settingsIpc.clearMemory).not.toHaveBeenCalled();
    await click(within(dialog).getByRole('button', { name: 'Clear memory' }));

    expect(settingsIpc.clearMemory).toHaveBeenCalledWith('r1');
  });

  it('applies pushed snapshots, uses their revision, and unsubscribes on unmount', async () => {
    const { settingsIpc, push, off, view } = await renderMemory(snapshot('r1', []));

    await push(snapshot('r5', ['Lives in Pune'], { status: 'Saved 1 fact.' }));
    expect(screen.getByRole('textbox', { name: 'Fact 1' })).toHaveValue('Lives in Pune');
    expect(screen.getByText('Last learning: Saved 1 fact.')).toBeInTheDocument();

    await click(screen.getByRole('button', { name: 'Delete fact 1' }));
    expect(settingsIpc.removeMemoryFact).toHaveBeenCalledWith('r5', 'id-Lives in Pune');

    view.unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('shows a corrupted memory file error', async () => {
    await renderMemory(snapshot('r1', [], { error: 'agent-memory.md could not be read.' }));

    expect(screen.getByRole('alert')).toHaveTextContent('agent-memory.md could not be read.');
  });
});
