import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { ComputerUseSettings } from '../ComputerUseSettings';
import type { SettingsIpc } from '../settings-ipc';
import type { SettingsSectionProps } from '../settings-section-props';
import type { ComputerUseStatus } from '../../../shared/computer-use';
import type { AppConfig } from '../../../types/ipc';

afterEach(cleanup);

/** Renders with persistence that applies commits optimistically, like the real hook, so remembered tour state drives the page. */
async function renderPage(initial: ComputerUseStatus, agent: Partial<AppConfig['agent']> = {}) {
  let push: (next: ComputerUseStatus) => void = () => undefined;
  const settingsIpc = {
    getComputerUseStatus: mock(() => Promise.resolve(initial)),
    installComputerUse: mock(() => Promise.resolve()),
    cancelComputerUseInstall: mock(() => Promise.resolve()),
    uninstallComputerUse: mock(() => Promise.resolve<ComputerUseStatus>({ state: 'absent' })),
    onComputerUseStatusChanged: mock((callback: (next: ComputerUseStatus) => void) => {
      push = callback;
      return () => undefined;
    }),
  };
  const config = { agent: { enabled: true, mcpServers: [], ...agent } } as unknown as AppConfig;
  const onNavigate = mock(() => undefined);
  const commit = mock((_key: 'agent', _value: AppConfig['agent'], _fieldId: string) => Promise.resolve());
  function Page() {
    const [current, setCurrent] = useState(config);
    const persistence = {
      commit: (key: 'agent', value: AppConfig['agent'], fieldId: string) => {
        setCurrent((saved) => ({ ...saved, agent: value }));
        return commit(key, value, fieldId);
      },
      fieldErrors: {},
      clearFieldError: () => undefined,
      toast: null,
    };
    return (
      <ComputerUseSettings
        {...({
          config: current,
          persistence,
          settingsIpc: settingsIpc as unknown as SettingsIpc,
          onNavigate,
        } as unknown as SettingsSectionProps)}
      />
    );
  }
  await act(async () => { render(<Page />); });
  return {
    settingsIpc,
    commit,
    onNavigate,
    savedComputerUse: () => (commit.mock.calls.at(-1)?.[1] ?? config.agent).computerUse,
    push: (next: ComputerUseStatus) => act(async () => push(next)),
  };
}

const click = (element: HTMLElement) => act(async () => { fireEvent.click(element); });
const button = (name: string) => screen.getByRole('button', { name });
const guideStep = () => screen.queryByText(/^Step \d of 4$/)?.closest('[role="group"]')?.textContent ?? null;
const bubble = (name: string) => screen.getByRole('group', { name });

describe('ComputerUseSettings', () => {
  it('starts the guide on first run and walks install to opt-in without enabling anything itself', async () => {
    const { settingsIpc, savedComputerUse, push } = await renderPage({ state: 'absent' });
    expect(savedComputerUse()).toEqual({ enabled: false, toolPolicies: {}, tourCompleted: false });
    expect(bubble('What Computer Use does')).toHaveFocus();
    expect(screen.getByRole('switch', { name: 'Let the agent use your desktop' })).toBeDisabled();

    await click(button('Next'));
    expect(bubble('Install the desktop helper')).toHaveFocus();
    expect(button('Next')).toBeDisabled();

    await click(button('Install'));
    await push({ state: 'installing', receivedBytes: 1, totalBytes: 4 });
    expect(screen.getByRole('status')).toHaveTextContent('Downloading… 25%');
    await click(button('Cancel'));
    expect(settingsIpc.cancelComputerUseInstall).toHaveBeenCalledTimes(1);
    await push({ state: 'failed', reason: 'Download cancelled.' });
    expect(guideStep()).toContain('did not finish');
    expect(button('Next')).toBeDisabled();

    await click(button('Retry'));
    expect(settingsIpc.installComputerUse).toHaveBeenCalledTimes(2);
    await push({ state: 'installed' });
    await click(button('Next'));
    expect(guideStep()).toContain('Step 3 of 4');
    expect(savedComputerUse()?.enabled).toBe(false);

    await click(screen.getByRole('switch', { name: 'Let the agent use your desktop' }));
    expect(savedComputerUse()).toEqual({ enabled: true, toolPolicies: {}, tourCompleted: false });
  });

  it('resumes an unfinished guide at the download after Settings reopens', async () => {
    await renderPage({ state: 'installing', receivedBytes: 0, totalBytes: 4 },
      { computerUse: { enabled: false, toolPolicies: {}, tourCompleted: false } });
    expect(bubble('Install the desktop helper')).toBeInTheDocument();
  });

  for (const [who, status, computerUse] of [
    ['an existing install', { state: 'installed' }, undefined],
    ['an existing opt-in whose helper was removed', { state: 'absent' }, { enabled: true, toolPolicies: {} }],
    ['someone who finished or skipped it', { state: 'absent' }, { enabled: false, toolPolicies: {}, tourCompleted: true }],
  ] as const) {
    it(`does not start the guide for ${who}`, async () => {
      const { commit } = await renderPage(status, { computerUse });
      expect(guideStep()).toBeNull();
      expect(commit).not.toHaveBeenCalled();
    });
  }

  it('remembers a guide dismissed with Escape, returns focus to Show guide, and replays it on request', async () => {
    const { savedComputerUse } = await renderPage({ state: 'absent' });
    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); });
    expect(savedComputerUse()?.tourCompleted).toBe(true);
    expect(guideStep()).toBeNull();
    expect(button('Show guide')).toHaveFocus();

    await click(button('Show guide'));
    expect(savedComputerUse()?.tourCompleted).toBe(false);
    expect(bubble('What Computer Use does')).toHaveFocus();
    await click(button('Skip guide'));
    expect(savedComputerUse()?.tourCompleted).toBe(true);
  });

  it('sends someone with Agent Mode off to Agent settings instead of turning it on', async () => {
    const { commit, onNavigate } = await renderPage({ state: 'installed' },
      { enabled: false, computerUse: { enabled: false, toolPolicies: {}, tourCompleted: false } });
    await click(button('Open Agent settings'));
    expect(onNavigate).toHaveBeenCalledWith('agent');
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps tool policies editable while the guide points at them, then finishes', async () => {
    const { savedComputerUse } = await renderPage({ state: 'installed' },
      { computerUse: { enabled: false, toolPolicies: {}, tourCompleted: false } });
    await click(button('Next'));
    expect(bubble('Choose what each tool may do')).toHaveFocus();

    await click(screen.getByRole('combobox', { name: 'Approval policy for Read a window' }));
    await click(screen.getByRole('option', { name: 'Always allow' }));
    await click(button('Done'));
    expect(savedComputerUse()).toEqual({ enabled: false, toolPolicies: { desktop_snapshot: 'alwaysAllow' }, tourCompleted: true });
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

  it('shows why an unsupported platform cannot use it, with nothing to turn on or tour', async () => {
    const { commit } = await renderPage({ state: 'unsupported', reason: 'Computer Use is not available on Windows yet.' });
    expect(screen.getByRole('status')).toHaveTextContent('Computer Use is not available on Windows yet.');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(commit).not.toHaveBeenCalled();
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

  it('requires confirmation before bulk-allowing tools, preserves clipboard access, and turns off immediately', async () => {
    const clipboardPolicies = { desktop_clipboard_get: 'alwaysAsk', desktop_clipboard_set: 'alwaysAllow', desktop_clipboard_clear: 'disabled' } as const;
    const { commit, savedComputerUse } = await renderPage({ state: 'installed' }, {
      computerUse: { enabled: false, tourCompleted: true, toolPolicies: { ...clipboardPolicies, desktop_click: 'disabled' } },
    });
    expect(screen.queryByRole('switch', { name: 'YOLO mode' })).toBeNull();
    await click(button('Enable YOLO mode'));
    expect(screen.getByRole('alertdialog', { name: 'Enable YOLO mode?' })).toBeInTheDocument();
    expect(commit).not.toHaveBeenCalled();
    expect(button('Keep approvals')).toHaveFocus();
    await click(button('Keep approvals'));
    await waitFor(() => expect(document.activeElement === button('Enable YOLO mode')).toBe(true));
    expect(commit).not.toHaveBeenCalled();

    await click(button('Enable YOLO mode'));
    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); });
    await waitFor(() => expect(document.activeElement === button('Enable YOLO mode')).toBe(true));
    expect(commit).not.toHaveBeenCalled();

    await click(button('Enable YOLO mode'));
    await click(button('Enable YOLO mode'));
    await waitFor(() => expect(document.activeElement === button('Turn off YOLO mode')).toBe(true));
    for (const select of screen.getAllByRole('combobox').filter(select => !select.getAttribute('aria-label')?.includes('clipboard'))) {
      expect(select).toHaveTextContent('Always allow');
    }
    expect(savedComputerUse()).toMatchObject({ enabled: false, tourCompleted: true, toolPolicies: clipboardPolicies });

    await click(screen.getByRole('combobox', { name: 'Approval policy for Read a window' }));
    await click(screen.getByRole('option', { name: 'Always ask' }));
    expect(button('Enable YOLO mode')).toBeInTheDocument();

    await click(button('Enable YOLO mode'));
    await click(button('Enable YOLO mode'));
    await click(button('Turn off YOLO mode'));
    expect(button('Enable YOLO mode')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    for (const select of screen.getAllByRole('combobox').filter(select => !select.getAttribute('aria-label')?.includes('clipboard'))) {
      expect(select).toHaveTextContent('Always ask');
    }
    expect(savedComputerUse()).toMatchObject({ enabled: false, tourCompleted: true, toolPolicies: clipboardPolicies });
  });
});
