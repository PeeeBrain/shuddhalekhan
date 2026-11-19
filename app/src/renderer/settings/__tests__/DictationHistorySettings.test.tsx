import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DictationHistorySettings } from '../DictationHistorySettings';
import type { SettingsIpc } from '../settings-ipc';
import type { SettingsSectionProps } from '../settings-section-props';
import type { AppConfig, DictationHistoryPage, DictationHistoryRow } from '../../../types/ipc';

afterEach(cleanup);

const row = (id: number, text: string): DictationHistoryRow => ({
  id, text, createdAt: '2026-11-20T10:00:00.000Z', provider: 'openai', model: null, delivery: 'dispatched', truncated: false,
});

async function renderHistory(settingsIpc: Partial<SettingsIpc>) {
  await act(async () => {
    render(
      <DictationHistorySettings
        {...({
          config: { dictationHistoryDays: 30 } as AppConfig,
          persistence: { commit: mock(() => Promise.resolve()), fieldErrors: {} },
          settingsIpc: { onDictationHistoryChanged: () => () => undefined, ...settingsIpc } as SettingsIpc,
        } as unknown as SettingsSectionProps)}
      />,
    );
  });
}

/** One row per page, so the second row lives on an older page. */
function pagedList(rows: () => DictationHistoryRow[]) {
  return (_query: string, beforeId: number | null) => {
    const matching = rows().filter((entry) => entry.id < (beforeId ?? Infinity));
    return Promise.resolve({ entries: matching.slice(0, 1), hasMore: matching.length > 1 });
  };
}

describe('DictationHistorySettings', () => {
  it('steps back to the newer page when the older page empties', async () => {
    let rows = [row(2, 'newer dictation'), row(1, 'older dictation')];
    await renderHistory({
      listDictationHistory: pagedList(() => rows),
      deleteDictationHistoryEntry: (id: number) => {
        rows = rows.filter((entry) => entry.id !== id);
        return Promise.resolve();
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Older' }));
    expect(await screen.findByText('older dictation')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Dictation' }));

    expect(await screen.findByText('newer dictation')).toBeInTheDocument();
    expect(screen.queryByText(/No Dictations yet/)).toBeNull();
  });

  it('keeps a failed delete visible after the list refreshes', async () => {
    const list = mock(pagedList(() => [row(1, 'kept dictation')]));
    await renderHistory({
      listDictationHistory: list,
      deleteDictationHistoryEntry: () => Promise.reject(new Error('disk full')),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Dictation' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Could not delete this Dictation.');
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toContain('Could not delete this Dictation.');
  });

  it('holds paging until the requested page arrives', async () => {
    let resolveOlder: ((page: DictationHistoryPage) => void) | undefined;
    await renderHistory({
      listDictationHistory: (_query: string, beforeId: number | null) => beforeId === null
        ? Promise.resolve({ entries: [row(3, 'newest')], hasMore: true })
        : new Promise<DictationHistoryPage>((resolve) => { resolveOlder = resolve; }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Older' }));
    await waitFor(() => expect(resolveOlder).toBeDefined());
    // A second click now would reuse the cursor from the page still on screen and request the same page.
    expect(screen.getByRole('button', { name: 'Older' })).toBeDisabled();

    await act(async () => resolveOlder?.({ entries: [row(2, 'middle')], hasMore: true }));
    expect(screen.getByText('middle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Older' })).toBeEnabled();
  });
});
