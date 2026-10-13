import { useEffect, useId, useState } from 'react';
import type { AgentMemorySnapshot } from '../../shared/agent-context';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { SectionHeader, SettingsCard, SettingsPanel, SettingsPanelHeader } from './ui/SectionHeader';
import { ToggleRow } from './ui/rows';
import { ipcErrorMessage } from './use-settings-persistence';
import type { SettingsSectionProps } from './settings-section-props';

const FIELD_ID_MEMORY = 'agent-memory-enabled';

export function MemorySettings({ config, persistence, settingsIpc }: SettingsSectionProps) {
  const [snapshot, setSnapshot] = useState<AgentMemorySnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, { text: string; value: string }>>({});
  const enabledErrorId = useId();

  useEffect(() => {
    let active = true;
    // A pushed snapshot is always newer than the initial read, so the read never overwrites it.
    let pushed = false;
    const off = settingsIpc.onMemoryChanged((next) => {
      pushed = true;
      setSnapshot(next);
    });
    settingsIpc.getMemory()
      .then((next) => {
        if (active && !pushed) setSnapshot(next);
      })
      .catch((cause) => {
        if (active) setLoadError(ipcErrorMessage(cause, 'Could not read saved memory.'));
      });
    return () => {
      active = false;
      off?.();
    };
  }, [settingsIpc]);

  /** Every mutation carries the revision it was made against; on any failure, reload so the next attempt is current. */
  const mutate = async (action: (revision: string) => Promise<AgentMemorySnapshot>, fallback: string): Promise<boolean> => {
    if (!snapshot) return false;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await action(snapshot.revision));
      return true;
    } catch (cause) {
      setError(ipcErrorMessage(cause, fallback));
      await settingsIpc.getMemory().then(setSnapshot, () => undefined);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const memoryEnabled = config.agent.memoryEnabled ?? false;
  const facts = snapshot?.facts ?? [];
  const rows = [...facts, ...Object.entries(drafts)
    .filter(([id]) => !facts.some(fact => fact.id === id))
    .map(([id, draft]) => ({ id, text: draft.text }))];
  const discardDraft = (id: string) => setDrafts(current => {
    const next = { ...current };
    delete next[id];
    return next;
  });

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Memory"
        description="Let Agent Mode remember your preferences and facts about you between commands."
      />

      <SettingsCard>
        <ToggleRow
          title="Enable memory"
          description="After each successful Agent Mode command, the agent makes one extra, small request to your selected model to save useful preferences and facts. Saved facts are sent with later commands to whichever model you select. Turning this off stops reading and learning but keeps saved facts."
          checked={memoryEnabled}
          tone="agent"
          errorId={enabledErrorId}
          error={persistence.fieldErrors[FIELD_ID_MEMORY]}
          onChange={(checked) => {
            void persistence.commit('agent', { ...config.agent, memoryEnabled: checked }, FIELD_ID_MEMORY);
          }}
        />
      </SettingsCard>

      {snapshot?.status ? (
        <p className="px-1 text-xs leading-5 text-muted-foreground">Last learning: {snapshot.status}</p>
      ) : null}

      {loadError || snapshot?.error || error ? (
        <div role="alert" className="space-y-1 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {[loadError, snapshot?.error, error].filter(Boolean).map((message) => (
            <p key={message} className="break-words">{message}</p>
          ))}
        </div>
      ) : null}

      <SettingsPanel aria-labelledby="memory-facts-heading">
        <SettingsPanelHeader
          id="memory-facts-heading"
          title="Saved facts"
          description="Clearing memory does not erase History; past agent runs are kept separately."
          actions={(
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              disabled={busy || !snapshot || (facts.length === 0 && !snapshot.error)}
              onClick={() => setConfirmClear(true)}
            >
              Clear memory
            </Button>
          )}
        />
        {snapshot === null ? (
          <SettingsCard className="py-8 text-center text-sm text-muted-foreground">
            {loadError ? 'Saved facts are unavailable.' : 'Loading memory…'}
          </SettingsCard>
        ) : rows.length === 0 ? (
          <SettingsCard className="py-8 text-center text-sm text-muted-foreground">
            No saved facts yet.
          </SettingsCard>
        ) : (
          <SettingsCard className="divide-y divide-border/50">
            {rows.map((fact, index) => (
              <FactRow
                key={fact.id}
                text={fact.text}
                draft={drafts[fact.id]?.value ?? null}
                conflict={!facts.some(saved => saved.id === fact.id)}
                onChange={(value) => setDrafts(current => ({ ...current, [fact.id]: { text: fact.text, value } }))}
                onDiscard={() => discardDraft(fact.id)}
                label={`Fact ${index + 1}`}
                busy={busy}
                onSave={async (text) => {
                  const saved = await mutate((revision) => settingsIpc.editMemoryFact(revision, fact.id, text), 'Could not save this fact.');
                  if (saved) discardDraft(fact.id);
                  return saved;
                }}
                onDelete={() => void mutate((revision) => settingsIpc.removeMemoryFact(revision, fact.id), 'Could not delete this fact.')}
              />
            ))}
          </SettingsCard>
        )}
      </SettingsPanel>

      <ConfirmDialog
        open={confirmClear}
        title="Clear memory?"
        description="Deletes every saved fact. History of past agent runs is kept separately and is not erased."
        confirmLabel="Clear memory"
        onConfirm={() => {
          setConfirmClear(false);
          void mutate(settingsIpc.clearMemory, 'Could not clear memory.');
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}

/** Keeps its draft until a save succeeds, so a failed or conflicting save never loses typing. */
function FactRow({
  text,
  draft,
  conflict,
  onChange,
  onDiscard,
  label,
  busy,
  onSave,
  onDelete,
}: {
  text: string;
  draft: string | null;
  conflict: boolean;
  onChange: (value: string) => void;
  onDiscard: () => void;
  label: string;
  busy: boolean;
  onSave: (text: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const value = draft ?? text;
  const dirty = draft !== null && draft.trim() !== text;

  return (
    <form
      className="flex items-center gap-2 py-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (conflict || !dirty || !value.trim()) return;
        void onSave(value.trim());
      }}
    >
      <Input
        className="h-9 flex-1"
        aria-label={label}
        maxLength={512}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onDiscard();
        }}
      />
      {dirty ? (
        <Button type="submit" size="sm" disabled={busy || conflict || !value.trim()}>
          Save
        </Button>
      ) : null}
      {conflict ? (
        <>
          <p role="alert" className="text-xs text-destructive">This fact changed or was removed. Your draft is kept; copy it before discarding.</p>
          <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>Discard draft</Button>
        </>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-destructive"
        disabled={busy || conflict}
        aria-label={`Delete ${label.toLowerCase()}`}
        onClick={onDelete}
      >
        Delete
      </Button>
    </form>
  );
}
