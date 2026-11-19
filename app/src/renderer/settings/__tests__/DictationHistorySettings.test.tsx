import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DictationHistorySettings } from '../DictationHistorySettings';
import type { SettingsIpc } from '../settings-ipc';
import type { SettingsSectionProps } from '../settings-section-props';
import type { AppConfig, DictationHistoryRow } from '../../../types/ipc';

afterEach(cleanup);

const row = (id: number, text: string): DictationHistoryRow => ({
  id, text, createdAt: '2026-11-20T10:00:00.000Z', provider: 'openai', model: null, delivery: 'dispatched', truncated: false,
});

describe('DictationHistorySettings', () => {
  it('steps back to the newer page when the older page empties', async () => {
    let rows = [row(2, 'newer dictation'), row(1, 'older dictation')];
    // One row per page, so the second row lives on an older page.
    const settingsIpc = {
      listDictationHistory: mock((_query: string, beforeId: number | null) => {
        const matching = rows.filter((entry) => entry.id < (beforeId ?? Infinity));
        return Promise.resolve({ entries: matching.slice(0, 1), hasMore: matching.length > 1 });
      }),
      deleteDictationHistoryEntry: mock((id: number) => {
        rows = rows.filter((entry) => entry.id !== id);
        return Promise.resolve();
      }),
      onDictationHistoryChanged: mock(() => () => undefined),
    };
    await act(async () => {
      render(
        <DictationHistorySettings
          {...({
            config: { dictationHistoryDays: 30 } as AppConfig,
            persistence: { commit: mock(() => Promise.resolve()), fieldErrors: {} },
            settingsIpc: settingsIpc as unknown as SettingsIpc,
          } as unknown as SettingsSectionProps)}
        />,
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Older' }));
    expect(await screen.findByText('older dictation')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Dictation' }));

    expect(await screen.findByText('newer dictation')).toBeInTheDocument();
    expect(screen.queryByText(/No Dictations yet/)).toBeNull();
  });
});
