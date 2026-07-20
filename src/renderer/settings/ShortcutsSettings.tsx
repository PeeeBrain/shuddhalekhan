import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type {
  RecordingIntent,
  ShortcutBinding,
  ShortcutsConfig,
} from '../../types/ipc';
import { assessBinding, formatBinding } from '../../shared/shortcut-bindings';
import { Button } from '@/components/ui/button';
import { SectionHeader } from './ui/SectionHeader';
import { Keycaps, ToggleRow } from './ui/rows';
import type { SettingsSectionProps } from './settings-section-props';
import {
  captureKeyDown,
  captureKeyUp,
  EMPTY_CAPTURE_STATE,
  type ShortcutCaptureResult,
  type ShortcutCaptureState,
} from './shortcut-capture';

export function ShortcutsSettings(props: SettingsSectionProps) {
  const { settingsIpc } = props;
  const [paused, setPaused] = useState(false);
  const [pauseError, setPauseError] = useState<string | undefined>();

  useEffect(() => {
    let mounted = true;
    settingsIpc.getShortcutsPaused()
      .then((value) => mounted && setPaused(value))
      .catch(() => mounted && setPauseError('Could not read the global shortcut state.'));
    const off = settingsIpc.onShortcutsPausedChanged(setPaused);
    return () => {
      mounted = false;
      off?.();
    };
  }, [settingsIpc]);

  const updatePaused = async (value: boolean) => {
    setPaused(value);
    setPauseError(undefined);
    try {
      setPaused(await settingsIpc.setShortcutsPaused(value));
    } catch {
      setPaused(!value);
      setPauseError('Could not update the global shortcut state.');
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Shortcuts"
        description="Choose an independent global binding and recording behavior for each intent."
      />

      <section className="rounded-lg border border-border/60 bg-card px-6" aria-label="Global shortcut pause">
        <ToggleRow
          title="Pause global shortcuts"
          description="Temporarily allow configured keys to pass through. Active recordings still finish normally. This resets when Shuddhalekhan restarts."
          checked={paused}
          errorId="shortcut-pause-error"
          error={pauseError}
          onChange={(value) => void updatePaused(value)}
        />
        {paused ? (
          <p className="pb-5 text-sm text-warning" role="status">
            <strong>Global shortcuts are paused.</strong> New Dictation and Agent Mode sessions will not start.
          </p>
        ) : null}
      </section>

      <section className="rounded-lg border border-border/60 bg-card px-6" aria-label="Shortcut bindings">
        <ShortcutRow intent="dictation" {...props} />
        <ShortcutRow intent="agent" {...props} />
      </section>
    </div>
  );
}

function ShortcutRow({
  intent,
  config,
  settingsIpc,
  persistence,
}: SettingsSectionProps & { intent: RecordingIntent }) {
  const shortcut = config.shortcuts[intent];
  const otherIntent = intent === 'dictation' ? 'agent' : 'dictation';
  const label = intent === 'dictation' ? 'Dictation' : 'Agent Mode';
  const fieldId = `shortcut-${intent}`;
  const [capturing, setCapturing] = useState(false);
  const [captureState, setCaptureState] = useState<ShortcutCaptureState>(EMPTY_CAPTURE_STATE);
  const captureStateRef = useRef(captureState);
  const captureActiveRef = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingWarning, setPendingWarning] = useState<{
    binding: ShortcutBinding;
    message: string;
  } | null>(null);
  const changeButtonRef = useRef<HTMLButtonElement | null>(null);
  const captureRef = useRef<HTMLDivElement | null>(null);

  const setTrackedCaptureState = (state: ShortcutCaptureState) => {
    captureStateRef.current = state;
    setCaptureState(state);
  };

  const restoreFocus = () => {
    requestAnimationFrame(() => changeButtonRef.current?.focus());
  };

  const stopCapture = () => {
    if (!captureActiveRef.current) return;
    captureActiveRef.current = false;
    void settingsIpc.endShortcutCapture();
  };

  useEffect(() => {
    return () => stopCapture();
    // settingsIpc is stable for the lifetime of a rendered Settings window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (capturing) captureRef.current?.focus();
  }, [capturing]);

  const commitBinding = async (binding: ShortcutBinding | null) => {
    const next: ShortcutsConfig = {
      ...config.shortcuts,
      [intent]: { ...shortcut, binding },
    };
    setPendingWarning(null);
    setCapturing(false);
    stopCapture();
    setMessage(binding ? `${label} shortcut saved as ${formatBinding(binding)}.` : `${label} shortcut cleared.`);
    await persistence.commit('shortcuts', next, fieldId);
    restoreFocus();
  };

  const beginCapture = async () => {
    setMessage(null);
    setPendingWarning(null);
    setTrackedCaptureState(EMPTY_CAPTURE_STATE);
    try {
      await settingsIpc.beginShortcutCapture();
      captureActiveRef.current = true;
      setCapturing(true);
      setMessage(`Recording a new ${label} shortcut. Press keys, or Escape to cancel.`);
    } catch {
      setMessage('Could not suspend global shortcuts for capture. Try again.');
    }
  };

  const cancelCapture = () => {
    setCapturing(false);
    setPendingWarning(null);
    setTrackedCaptureState(EMPTY_CAPTURE_STATE);
    stopCapture();
    setMessage(`${label} shortcut capture cancelled.`);
    restoreFocus();
  };

  const processResult = (result: ShortcutCaptureResult) => {
    setTrackedCaptureState(result.state);
    if (result.kind === 'state') return;
    if (result.kind === 'cancel') {
      cancelCapture();
      return;
    }
    if (result.kind === 'clear') {
      void commitBinding(null);
      return;
    }
    if (result.kind === 'unsupported') {
      setMessage(result.message);
      setTrackedCaptureState(EMPTY_CAPTURE_STATE);
      return;
    }

    const verdict = assessBinding(result.binding, config.shortcuts[otherIntent].binding);
    if (verdict.status === 'error') {
      setMessage(verdict.message);
      setTrackedCaptureState(EMPTY_CAPTURE_STATE);
      return;
    }
    if (verdict.status === 'warning') {
      setPendingWarning({ binding: result.binding, message: verdict.message });
      setCapturing(false);
      stopCapture();
      setMessage(`Confirmation required for ${formatBinding(result.binding)}.`);
      return;
    }
    void commitBinding(result.binding);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    processResult(captureKeyDown(captureStateRef.current, event.code, event.repeat));
  };

  const handleKeyUp = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    processResult(captureKeyUp(captureStateRef.current, event.code));
  };

  const updateActivationMode = (activationMode: 'push-to-talk' | 'toggle') => {
    const next: ShortcutsConfig = {
      ...config.shortcuts,
      [intent]: { ...shortcut, activationMode },
    };
    void persistence.commit('shortcuts', next, `${fieldId}-mode`);
  };

  const previewBinding: ShortcutBinding | null = captureState.started
    ? { keyCode: captureState.keyCode, modifiers: captureState.modifiers }
    : null;

  return (
    <div className="border-b border-border/70 py-5 last:border-b-0">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          <h3 className="text-sm font-medium">{label}</h3>
          <p className="text-xs text-muted-foreground">
            {intent === 'agent' && !config.agent.enabled
              ? 'Saved but dormant while Agent Mode is disabled.'
              : shortcut.activationMode === 'toggle'
                ? 'Press once to start and again to stop.'
                : 'Hold the shortcut to record; release it to stop.'}
          </p>
          <Keycaps
            value={formatBinding(shortcut.binding)}
            label={`${label} shortcut: ${formatBinding(shortcut.binding)}`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`${fieldId}-mode`}>{label} activation mode</label>
          <select
            id={`${fieldId}-mode`}
            value={shortcut.activationMode}
            onChange={(event) => updateActivationMode(event.target.value as 'push-to-talk' | 'toggle')}
            className="h-8 w-[8.5rem] rounded-md border border-input bg-background px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="push-to-talk">Push to Talk</option>
            <option value="toggle">Toggle</option>
          </select>
          <Button ref={changeButtonRef} size="sm" variant="outline" onClick={() => void beginCapture()}>
            Change
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!shortcut.binding}
            onClick={() => void commitBinding(null)}
          >
            Clear
          </Button>
        </div>
      </div>

      {capturing ? (
        <div
          ref={captureRef}
          tabIndex={0}
          role="group"
          aria-label={`Capture ${label} shortcut`}
          aria-describedby={`${fieldId}-capture-help`}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onBlur={cancelCapture}
          className="mt-4 rounded-md border border-primary/60 bg-primary/5 p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p className="text-sm font-medium">Press the new shortcut</p>
          <div className="mt-3 min-h-7">
            {previewBinding ? (
              <Keycaps value={formatBinding(previewBinding)} label={`Pressed: ${formatBinding(previewBinding)}`} />
            ) : (
              <span className="text-sm text-muted-foreground">Waiting for keys…</span>
            )}
          </div>
          <p id={`${fieldId}-capture-help`} className="mt-3 text-xs text-muted-foreground">
            Release all keys to save. Escape cancels. Backspace or Delete clears while waiting; hold a modifier first to assign either key.
          </p>
        </div>
      ) : null}

      {pendingWarning ? (
        <div className="mt-4 rounded-md border border-warning/50 bg-warning/10 p-4" role="alert">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">This shortcut can disrupt normal typing</p>
                <p className="mt-1 text-xs text-muted-foreground">{pendingWarning.message}</p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void commitBinding(pendingWarning.binding)}>Use anyway</Button>
                <Button size="sm" variant="outline" onClick={cancelCapture}>Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <p
        id={`${fieldId}-status`}
        role="status"
        aria-live="polite"
        className={`mt-3 text-xs ${message?.includes('cannot') || message?.includes('not supported') || message?.includes('Could not') ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {message ?? persistence.fieldErrors[fieldId] ?? ''}
      </p>
    </div>
  );
}
