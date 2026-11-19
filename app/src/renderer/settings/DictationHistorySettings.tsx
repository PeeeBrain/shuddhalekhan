import { useEffect, useState } from 'react';
import { Check, Copy, Search, Trash2 } from 'lucide-react';
import {
  DICTATION_HISTORY_DAYS,
  type DictationDelivery,
  type DictationHistoryDays,
  type DictationHistoryEntry,
  type DictationHistoryPage,
  type DictationHistoryRow,
} from '../../types/ipc';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { SectionHeader, SettingsCard, SettingsPanel, SettingsPanelHeader } from './ui/SectionHeader';
import { SelectRow, Tag, type TagTone } from './ui/rows';
import { transcriptionProviderLabel } from './settings-model';
import { ipcErrorMessage } from './use-settings-persistence';
import type { SettingsSectionProps } from './settings-section-props';

const RETENTION_LABELS: Record<DictationHistoryDays, string> = {
  0: 'Off', 1: '1 day', 7: '7 days', 30: '30 days', 90: '90 days',
};

/** Paste reports only what was sent; none of these claim the target app accepted the text. */
const DELIVERY: Record<DictationDelivery, { label: string; tone: TagTone }> = {
  dispatched: { label: 'Paste sent', tone: 'success' },
  uncertain: { label: 'Paste uncertain', tone: 'warning' },
  failed: { label: 'Paste failed', tone: 'error' },
};

export function DictationHistorySettings({ config, persistence, settingsIpc }: SettingsSectionProps) {
  const days = config.dictationHistoryDays;
  const [query, setQuery] = useState('');
  // Page cursors: Older pushes the last row's id, Newer pops it. Only one page is ever rendered.
  const [cursors, setCursors] = useState<Array<number | null>>([null]);
  const [page, setPage] = useState<DictationHistoryPage | null>(null);
  const [reload, setReload] = useState(0);
  // Paging waits for the requested page: a cursor taken from the page still on screen would repeat or skip rows.
  const [loading, setLoading] = useState(true);
  const goTo = (next: (current: Array<number | null>) => Array<number | null>) => {
    setLoading(true);
    setCursors(next);
  };
  // Kept apart so a list refresh never hides a failed copy, delete, or clear.
  const [listError, setListError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openEntry, setOpenEntry] = useState<DictationHistoryEntry | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const beforeId = cursors[cursors.length - 1];

  useEffect(() => settingsIpc.onDictationHistoryChanged(() => setReload((n) => n + 1)), [settingsIpc]);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      settingsIpc.listDictationHistory(query, beforeId).then(
        (next) => {
          if (!active) return;
          // Deleting or pruning can empty an older page; step back instead of claiming History is empty.
          if (next.entries.length === 0 && beforeId !== null) return setCursors((current) => current.slice(0, -1));
          setPage(next);
          setListError(null);
          setLoading(false);
        },
        (cause) => { if (active) setListError(ipcErrorMessage(cause, 'Could not read History.')); },
      );
    }, query ? 150 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [settingsIpc, query, beforeId, reload, days]);

  useEffect(() => {
    if (copiedId === null) return;
    const timer = setTimeout(() => setCopiedId(null), 1500);
    return () => clearTimeout(timer);
  }, [copiedId]);

  const mutate = async (action: () => Promise<void>, fallback: string) => {
    try {
      await action();
      setError(null);
    } catch (cause) {
      setError(ipcErrorMessage(cause, fallback));
    }
    setReload((n) => n + 1);
  };

  const toggle = (row: DictationHistoryRow) => {
    if (openEntry?.id === row.id) {
      setOpenEntry(null);
      return;
    }
    settingsIpc.getDictationHistoryEntry(row.id).then(setOpenEntry, (cause) => setError(ipcErrorMessage(cause, 'Could not open this Dictation.')));
  };

  const rows = page?.entries ?? [];

  return (
    <div className="space-y-8">
      <SectionHeader
        title="History"
        description="Your recent Dictations, kept as text on this computer. Audio and Agent Mode commands are never saved here."
      />

      <SettingsCard>
        <SelectRow
          label="Keep history"
          description="Up to 1,000 Dictations. Shortening this or turning it off deletes older Dictations right away."
          value={String(days)}
          options={DICTATION_HISTORY_DAYS.map((value) => ({ value: String(value), label: RETENTION_LABELS[value] }))}
          errorId="dictation-history-days-error"
          error={persistence.fieldErrors['dictation-history-days']}
          onChange={(value) => {
            void persistence.commit('dictationHistoryDays', Number(value) as DictationHistoryDays, 'dictation-history-days');
          }}
        />
      </SettingsCard>

      {error ?? listError ? (
        <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive break-words">
          {error ?? listError}
        </p>
      ) : null}

      {days === 0 ? (
        <SettingsCard className="py-8 text-center text-sm text-muted-foreground">
          History is off. New Dictations are not saved.
        </SettingsCard>
      ) : (
        <SettingsPanel aria-labelledby="dictation-history-heading">
          <SettingsPanelHeader
            id="dictation-history-heading"
            title="Dictations"
            actions={(
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={!page || (rows.length === 0 && !query && cursors.length === 1)}
                onClick={() => setConfirmClear(true)}
              >
                Clear all
              </Button>
            )}
          />
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                goTo(() => [null]);
              }}
              placeholder="Search Dictations"
              aria-label="Search Dictations"
              className="h-9 pl-8"
            />
          </div>

          {!page ? (
            <SettingsCard className="py-8 text-center text-sm text-muted-foreground">
              {listError ? 'History is unavailable.' : 'Loading History…'}
            </SettingsCard>
          ) : rows.length === 0 ? (
            <SettingsCard className="py-8 text-center text-sm text-muted-foreground">
              {query.trim() ? 'No Dictations match this search.' : 'No Dictations yet. Each one you finish appears here, including any that could not be pasted.'}
            </SettingsCard>
          ) : (
            <SettingsCard>
              <ul aria-label="Dictations" className="divide-y divide-border/50">
                {rows.map((row) => (
                  <HistoryRow
                    key={row.id}
                    row={row}
                    entry={openEntry?.id === row.id ? openEntry : null}
                    copied={copiedId === row.id}
                    onToggle={() => toggle(row)}
                    onCopy={() => settingsIpc.copyDictationHistoryEntry(row.id).then(
                      () => setCopiedId(row.id),
                      (cause) => setError(ipcErrorMessage(cause, 'Could not copy this Dictation.')),
                    )}
                    onDelete={() => {
                      if (openEntry?.id === row.id) setOpenEntry(null);
                      void mutate(() => settingsIpc.deleteDictationHistoryEntry(row.id), 'Could not delete this Dictation.');
                    }}
                  />
                ))}
              </ul>
            </SettingsCard>
          )}

          {cursors.length > 1 || page?.hasMore ? (
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" disabled={loading || cursors.length === 1}
                onClick={() => goTo((current) => current.slice(0, -1))}>
                Newer
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={loading || !page?.hasMore}
                onClick={() => goTo((current) => [...current, rows[rows.length - 1].id])}>
                Older
              </Button>
            </div>
          ) : null}
        </SettingsPanel>
      )}

      <ConfirmDialog
        open={confirmClear}
        title="Clear History?"
        description="Deletes every saved Dictation. Agent Mode history is kept separately and is not erased."
        confirmLabel="Clear History"
        onConfirm={() => {
          setConfirmClear(false);
          setOpenEntry(null);
          setCursors([null]);
          void mutate(settingsIpc.clearDictationHistory, 'Could not clear History.');
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}

function HistoryRow({ row, entry, copied, onToggle, onCopy, onDelete }: {
  row: DictationHistoryRow;
  /** The full entry, present while this row is open. */
  entry: DictationHistoryEntry | null;
  copied: boolean;
  onToggle: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const delivery = DELIVERY[row.delivery];
  return (
    <li className="flex items-start gap-3 py-3">
      <button
        type="button"
        aria-expanded={entry !== null}
        onClick={onToggle}
        className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <time dateTime={row.createdAt} className="tabular-nums">{formatWhen(row.createdAt)}</time>
          <Tag tone={delivery.tone}>{delivery.label}</Tag>
          <span className="truncate">
            {transcriptionProviderLabel(row.provider)}
            {row.model ? <span className="ml-1.5 text-muted-foreground/70">{row.model}</span> : null}
          </span>
        </span>
        <span className={cn('mt-1 block whitespace-pre-wrap break-words text-sm leading-6', !entry && 'line-clamp-2')}>
          {entry ? entry.text : `${row.text}${row.truncated ? '…' : ''}`}
        </span>
        {entry?.rawText ? (
          <span className="mt-2 block border-l-2 border-border pl-3">
            <span className="block text-xs text-muted-foreground">Before correction</span>
            <span className="block whitespace-pre-wrap break-words text-[13px] leading-5 text-muted-foreground">{entry.rawText}</span>
          </span>
        ) : null}
      </button>
      <div className="flex shrink-0 gap-1">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Copy Dictation" title="Copy" onClick={onCopy}>
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete Dictation" title="Delete"
          className="text-muted-foreground hover:text-destructive" onClick={onDelete}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
