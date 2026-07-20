import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { Tag } from './ui/rows';
import type { AppConfig } from '../../types/ipc';
import type { SettingsSectionId } from './settings-nav';
import type { SettingsPersistence } from './use-settings-persistence';
import { formatBinding } from '../../shared/shortcut-bindings';

interface SetupChecklistProps {
  config: AppConfig;
  onNavigate: (section: SettingsSectionId) => void;
  persistence: SettingsPersistence;
}

export function SetupChecklist({
  config,
  onNavigate,
  persistence,
}: SetupChecklistProps) {
  const whisperComplete =
    config.whisperUrl !== '' &&
    config.whisperUrl !== 'http://localhost:8080/inference';
  const micComplete = config.selectedDeviceId !== null && config.selectedDeviceId !== '';

  const items: Array<{
    label: string;
    done: boolean;
    action?: () => void;
  }> = [
    {
      label: 'Set Whisper endpoint',
      done: whisperComplete,
      action: () => onNavigate('transcription'),
    },
    {
      label: 'Select microphone',
      done: micComplete,
      action: () => onNavigate('audio'),
    },
    {
      label: config.shortcuts.dictation.binding
        ? `Try a dictation (${formatBinding(config.shortcuts.dictation.binding)})`
        : 'Assign a Dictation shortcut',
      done: false,
      action: config.shortcuts.dictation.binding ? undefined : () => onNavigate('shortcuts'),
    },
  ];

  return (
    <section
      aria-label="First-run setup"
      className="rounded-lg border border-border/60 bg-card px-6 py-5"
    >
      <div className="mb-3 flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold">First-run setup</h3>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss setup checklist"
          onClick={() => persistence.commit('setupChecklistDismissed', true, 'setup-checklist')}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.label}>
            <button
              type="button"
              disabled={!item.action}
              onClick={item.action}
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default"
            >
              <span className={item.done ? 'text-muted-foreground' : ''}>
                {item.label}
              </span>
              <Tag tone={item.done ? 'success' : 'neutral'}>
                {item.done ? 'Done' : 'To do'}
              </Tag>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
