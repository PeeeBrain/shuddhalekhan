import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, History, Search } from 'lucide-react';
import type { AuditRunSummary } from '../../types/ipc';
import type { SettingsIpc } from './settings-ipc';
import {
  matchPaletteItems,
  SETTINGS_NAV_SECTIONS,
  type PaletteItem,
  type SettingsSectionId,
} from './settings-nav';

interface CommandPaletteProps {
  settingsIpc: SettingsIpc;
  onClose: () => void;
  onNavigate: (section: SettingsSectionId) => void;
  onOpenRun: (agentRunId: string) => void;
}

/** Ctrl+K jump list for settings sections and recent agent runs; mounted only while open. */
export function CommandPalette({ settingsIpc, onClose, onNavigate, onOpenRun }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [runs, setRuns] = useState<AuditRunSummary[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    settingsIpc.getAuditRuns().then((all) => setRuns(all.slice(0, 50))).catch(() => setRuns([]));
  }, [settingsIpc]);

  const items = matchPaletteItems([
    ...SETTINGS_NAV_SECTIONS.map((section): PaletteItem => ({ kind: 'section', id: section.id, label: section.label })),
    ...runs.map((run): PaletteItem => ({
      kind: 'run',
      id: run.agentRunId,
      label: run.transcript || 'Empty prompt',
      meta: `${new Date(run.startedAt).toLocaleDateString()} ${run.status} ${run.tools.join(' ')}`,
    })),
  ], query).slice(0, 12);
  const current = Math.min(active, items.length - 1);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === 'section') onNavigate(item.id);
    else onOpenRun(item.id);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(items.length, 1);
      setActive(next);
      listRef.current?.querySelectorAll('[role="option"]')[next]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(items[current]);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/55 pt-[12vh] backdrop-blur-sm" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-[34rem] max-w-[calc(100vw-4rem)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2.5 border-b border-border/60 px-4">
          <Search aria-hidden="true" className="size-4 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            placeholder="Jump to a section or search agent runs"
            aria-label="Search settings and runs"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={items[current] ? `palette-${items[current].kind}-${items[current].id}` : undefined}
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <div ref={listRef} id="command-palette-list" role="listbox" className="max-h-80 overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing matches.</p>
          ) : items.map((item, index) => (
            <div
              key={`${item.kind}-${item.id}`}
              id={`palette-${item.kind}-${item.id}`}
              role="option"
              aria-selected={index === current}
              onMouseMove={() => setActive(index)}
              onClick={() => choose(item)}
              className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[13px] ${index === current ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}
            >
              {item.kind === 'run' ? <History aria-hidden="true" className="size-3.5 shrink-0" /> : null}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{item.kind === 'run' ? 'Agent run' : 'Section'}</span>
              {index === current ? <CornerDownLeft aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" /> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
