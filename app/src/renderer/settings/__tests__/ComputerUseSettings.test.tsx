import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ComputerUseSettings } from '../ComputerUseSettings';
import type { SettingsIpc } from '../settings-ipc';
import type { SettingsSectionProps } from '../settings-section-props';
import type { ComputerUseStatus } from '../../../shared/computer-use';
import type { AppConfig } from '../../../types/ipc';

afterEach(cleanup);

async function renderPage(initial: ComputerUseStatus, agent: Partial<AppConfig['agent']> = {}) {
  let push: (next: ComputerUseStatus) => void = () => undefined;
  const settingsIpc = {
    getComputerUseStatus: mock(() => Promise.resolve(initial)),
    installComputerUse: mock(() => Promise.resolve<ComputerUseStatus>({ state: 'installed' })),
    cancelComputerUseInstall: mock(() => Promise.resolve()),
    uninstallComputerUse: mock(() => Promise.resolve<ComputerUseStatus>({ state: 'absent' })),
    onComputerUseStatusChanged: mock((callback: (next: ComputerUseStatus) => void) => {
      push = callback;
      return () => undefined;
    }),
  };
  const commit = mock(() => Promise.resolve());
  const config = { agent: { enabled: true, mcpServers: [], ...agent } } as unknown as AppConfig;
  await act(async () => {
    render(
      <ComputerUseSettings
        {...({
          config,
          persistence: { commit, fieldErrors: {}, clearFieldError: () => undefined, toast: null },
          settingsIpc: settingsIpc as unknown as SettingsIpc,
        } as unknown as SettingsSectionProps)}
      />,
    );
  });
  return { settingsIpc, commit, push: (next: ComputerUseStatus) => act(async () => push(next)) };
}

const click = (element: HTMLElement) => act(async () => { fireEvent.click(element); });

describe('ComputerUseSettings', () => {
  it('keeps the agent off the desktop until the helper is installed, then saves the opt-in', async () => {
    const { settingsIpc, commit, push } = await renderPage({ state: 'absent' });
    const toggle = screen.getByRole('switch', { name: 'Let the agent use your desktop' });
    expect(toggle).toBeDisabled();

    await click(screen.getByRole('button', { name: 'Install' }));
    await push({ state: 'installing', receivedBytes: 1, totalBytes: 4 });
    expect(screen.getByRole('status')).toHaveTextContent('Downloading… 25%');
    expect(settingsIpc.installComputerUse).toHaveBeenCalledTimes(1);
    await push({ state: 'installed' });

    await click(screen.getByRole('switch', { name: 'Let the agent use your desktop' }));
    expect(commit).toHaveBeenCalledWith('agent', {
      enabled: true, mcpServers: [], computerUse: { enabled: true, toolPolicies: {} },
    }, 'computer-use-enabled');
  });

  for (const [why, status, agentEnabled] of [
    ['Agent Mode is off', { state: 'installed' }, false],
    ['the helper is missing', { state: 'absent' }, true],
  ] as const) {
    it(`lets a saved opt-in be turned off while ${why}`, async () => {
      const { commit } = await renderPage(status,
        { enabled: agentEnabled, computerUse: { enabled: true, toolPolicies: {} } });
      await click(screen.getByRole('switch', { name: 'Let the agent use your desktop' }));
      expect(commit).toHaveBeenCalledWith('agent', expect.objectContaining({
        computerUse: { enabled: false, toolPolicies: {} },
      }), 'computer-use-enabled');
    });
  }

  it('shows why an unsupported platform cannot use it, with nothing to turn on', async () => {
    await renderPage({ state: 'unsupported', reason: 'Computer Use is not available on Windows yet.' });
    expect(screen.getByRole('status')).toHaveTextContent('Computer Use is not available on Windows yet.');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('starts clipboard tools disabled and saves a changed policy by tool name', async () => {
    const { commit } = await renderPage({ state: 'installed' });
    expect(screen.getByRole('combobox', { name: 'Approval policy for Read the clipboard' })).toHaveTextContent('Disabled');
    const snapshot = screen.getByRole('combobox', { name: 'Approval policy for Read a window' });
    expect(snapshot).toHaveTextContent('Always ask');

    await click(snapshot);
    await click(screen.getByRole('option', { name: 'Always allow' }));
    expect(commit).toHaveBeenCalledWith('agent', {
      enabled: true, mcpServers: [], computerUse: { enabled: false, toolPolicies: { desktop_snapshot: 'alwaysAllow' } },
    }, 'computer-use-policies');
  });
});
