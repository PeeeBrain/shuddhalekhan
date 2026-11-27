import { DEFAULT_MANAGED_LOCAL } from '../../shared/managed-local-selection';
import { useEffect, useRef, useState } from 'react';
import { Check, Download, Mic, Keyboard, Settings, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { AppConfig, ManagedLocalModelState, RecordingActivationMode } from '../../types/ipc';
import type { SettingsIpc } from './settings-ipc';
import type { SettingsSectionId } from './settings-nav';
import { useManagedLocalSnapshot } from './use-managed-local-snapshot';
import { activeTrigger, useDesktopStatus } from './use-desktop-status';
import { ipcErrorMessage } from './use-settings-persistence';
import { Keycaps } from './ui/rows';

/**
 * First-run setup. `completed` comes only from main's onboarding:completed, sent after a
 * Dictation is actually inserted, so typing or clicking in the practice field never finishes setup.
 */
export function Onboarding({
  config,
  settingsIpc,
  completed,
  micVerified,
  onMicVerified,
  onOpenAdvanced,
  onFinish,
}: {
  config: AppConfig;
  settingsIpc: SettingsIpc;
  completed: boolean;
  /** Survives a trip to full Settings and back, so fixing a shortcut does not relock the practice field. */
  micVerified: boolean;
  onMicVerified: () => void;
  onOpenAdvanced: (section?: SettingsSectionId) => void;
  onFinish: () => void;
}) {
  const modelId = config.managedLocal?.model ?? DEFAULT_MANAGED_LOCAL.model;
  const { snapshot, loadError, refresh, accept } = useManagedLocalSnapshot(settingsIpc, modelId);
  const [micState, setMicState] = useState<'idle' | 'checking' | 'verified' | 'error'>(micVerified ? 'verified' : 'idle');
  const [micLevel, setMicLevel] = useState(0);
  const [installError, setInstallError] = useState('');
  // Owned from the click, not from permission: finishing or unmounting retires it,
  // and a permission grant that lands afterwards releases its tracks immediately.
  const micCheck = useRef<{ release: () => void } | null>(null);
  const desktopStatus = useDesktopStatus(settingsIpc);

  const releaseMicCheck = () => {
    micCheck.current?.release();
    micCheck.current = null;
  };

  useEffect(() => releaseMicCheck, []);

  // Onboarding always sets up the CPU files: they work offline and are Auto's fallback.
  // GPU setup stays an explicit choice in Settings.
  const entry = snapshot?.catalog.find((item) => item.key === modelId);
  const legacy = entry?.cpu.legacy?.inUse ? entry.cpu.legacy : null;
  const model = entry ? { name: entry.name, languages: entry.languages, ...entry.cpu } : null;

  const install = async () => {
    setInstallError('');
    try {
      accept(await settingsIpc.installManagedLocalModel(entry ? { model: modelId, backend: 'cpu' } : undefined));
    } catch (error) {
      setInstallError(ipcErrorMessage(error, 'Model installation failed. Retry.'));
      void refresh();
    }
  };

  const startMicrophoneCheck = async () => {
    if (micCheck.current) return;
    const check = { release: () => {} };
    micCheck.current = check;
    setMicState('checking');
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    try {
      const acquiredStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream = acquiredStream;
      if (micCheck.current !== check) {
        acquiredStream.getTracks().forEach((track) => track.stop());
        return;
      }
      const audioContext = new AudioContext();
      context = audioContext;
      const source = audioContext.createMediaStreamSource(acquiredStream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const values = new Uint8Array(analyser.frequencyBinCount);
      const timer = window.setInterval(() => {
        analyser.getByteTimeDomainData(values);
        const peak = values.reduce((largest, value) => Math.max(largest, Math.abs(value - 128)), 0);
        setMicLevel(Math.min(1, peak / 64));
      }, 100);
      check.release = () => {
        window.clearInterval(timer);
        acquiredStream.getTracks().forEach((track) => track.stop());
        void audioContext.close();
      };
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      if (context) void context.close();
      if (micCheck.current !== check) return;
      micCheck.current = null;
      setMicState('error');
    }
  };

  const finishMicrophoneCheck = () => {
    releaseMicCheck();
    setMicState('verified');
    onMicVerified();
    setMicLevel(0);
  };

  const modelReady = !!legacy || model?.state.kind === 'ready';
  const trigger = activeTrigger(desktopStatus, 'dictation', config.shortcuts.dictation.binding);

  return (
    <main className="min-h-full bg-background px-6 py-10 text-foreground">
      <div className="mx-auto max-w-2xl">
        <header className="mb-8">
          <p className="mb-2 text-[13px] font-medium text-muted-foreground">Welcome to Shuddhalekhan</p>
          <h1 className="text-3xl font-semibold tracking-tight">Set up Dictation</h1>
          <p className="mt-2 text-sm text-muted-foreground">Install private local speech recognition, check your microphone, then complete one real Dictation.</p>
        </header>

        <div className="space-y-4">
          <Step icon={Download} number="1" title="Install local speech recognition" done={modelReady}>
            {model ? (
              <>
                <p className="font-medium">{legacy?.name ?? model.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {legacy ? `${formatBytes(legacy.installedBytes)} installed`
                    : `${formatBytes(model.downloadBytes)} download · ${formatBytes(model.installedBytes)} installed · ${model.languages.join(', ')}`}
                </p>
                {legacy ? <p className="mt-3 text-sm text-success">Previous version installed and ready offline. You can update it later in Settings.</p>
                  : <ModelState state={model.state} />}
                {!modelReady && model.state.kind !== 'downloading' && model.state.kind !== 'installing' ? (
                  <Button className="mt-4" onClick={() => void install()}>
                    {model.state.kind === 'error' ? actionLabel(model.state.action) : 'Download model'}
                  </Button>
                ) : null}
              </>
            ) : loadError ? (
              <>
                <p role="alert" className="text-sm text-destructive">Could not check the local speech model.</p>
                <Button className="mt-4" variant="secondary" onClick={() => void refresh()}>Check again</Button>
              </>
            ) : <p className="text-sm text-muted-foreground">Checking model status…</p>}
            {installError ? <p role="alert" className="mt-3 text-sm text-destructive">{installError}</p> : null}
          </Step>

          <Step icon={Mic} number="2" title="Check your microphone" done={micState === 'verified'} disabled={!modelReady}>
            <p className="text-sm text-muted-foreground">Shuddhalekhan will use your default input device.</p>
            {micState === 'checking' ? (
              <div className="mt-4">
                <div className="h-2 overflow-hidden rounded-full bg-muted" aria-label="Microphone level">
                  <div className="h-full bg-primary" style={{ width: `${Math.max(4, micLevel * 100)}%` }} />
                </div>
                <p className="mt-2 text-sm">Speak and confirm that the level moves.</p>
                <Button className="mt-3" onClick={finishMicrophoneCheck}>My microphone works</Button>
              </div>
            ) : micState === 'verified' ? (
              <p className="mt-3 text-sm text-success">Microphone check complete.</p>
            ) : (
              <>
                <Button className="mt-4" disabled={!modelReady} onClick={() => void startMicrophoneCheck()}>Start microphone check</Button>
                {micState === 'error' ? <p role="alert" className="mt-3 text-sm text-destructive">Microphone access failed. Check your system microphone privacy settings, then retry.</p> : null}
              </>
            )}
          </Step>

          <Step icon={Keyboard} number="3" title="Try Dictation here" done={completed} disabled={!completed && micState !== 'verified'}>
            {trigger.kind === 'active' ? <ShortcutInstruction mode={config.shortcuts.dictation.activationMode} shortcut={trigger.text} /> : null}
            {trigger.kind === 'checking' ? <p className="text-sm text-muted-foreground">Checking your Dictation shortcut…</p> : null}
            {trigger.kind === 'inactive' ? (
              <Problem message={trigger.message} action="Change shortcut" onAction={() => onOpenAdvanced('shortcuts')} />
            ) : null}
            {desktopStatus && !desktopStatus.delivery.available ? (
              <Problem message={desktopStatus.delivery.message} action="Set up text insertion" onAction={() => onOpenAdvanced('transcription')} />
            ) : null}
            <PracticeField active={micState === 'verified'} completed={completed} />
            {completed ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">Dictation works the same way in every app.</p>
                <Button onClick={onFinish}>Open Settings</Button>
              </div>
            ) : null}
          </Step>
        </div>

        {completed ? null : (
          <button type="button" className="mt-6 inline-flex items-center gap-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={() => onOpenAdvanced()}>
            <Settings className="size-4" aria-hidden="true" />Configure an advanced provider
          </button>
        )}
      </div>
    </main>
  );
}

function Step({ icon: Icon, number, title, done, disabled = false, children }: {
  icon: React.ElementType;
  number: string;
  title: string;
  done: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`rounded-xl border border-border/60 bg-card p-6 ${disabled ? 'opacity-50' : ''}`} aria-labelledby={`onboarding-step-${number}`}>
      <div className="mb-4 flex items-center gap-3">
        <span className={`flex size-9 items-center justify-center rounded-full ${done ? 'bg-success/15 text-success' : 'bg-secondary text-primary'}`}>
          {done ? <Check className="size-5" aria-hidden="true" /> : <Icon className="size-5" aria-hidden="true" />}
        </span>
        <div>
          <p className="text-xs text-muted-foreground">Step {number}</p>
          <h2 id={`onboarding-step-${number}`} className="font-semibold">{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}

function ShortcutInstruction({ mode, shortcut }: { mode: RecordingActivationMode; shortcut: string }) {
  const keys = <Keycaps value={shortcut} label={shortcut} />;
  return (
    <p className="text-sm leading-8 text-muted-foreground">
      {mode === 'push-to-talk'
        ? <>Hold {keys}, say a sentence, then let go.</>
        : <>Press {keys}, say a sentence, then press it again.</>}
    </p>
  );
}

function Problem({ message, action, onAction }: { message: string; action: string; onAction: () => void }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-warning">
      <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">{message}</p>
      <Button size="sm" variant="secondary" onClick={onAction}>{action}</Button>
    </div>
  );
}

/**
 * A real, editable field the production Dictation pastes into. It only shows readiness;
 * success is main's acknowledgement, never this field's contents.
 */
function PracticeField({ active, completed }: { active: boolean; completed: boolean }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (active && !completed) field.current?.focus();
  }, [active, completed]);

  const status = completed
    // Main reports that a Dictation was inserted, not where; the user may have dictated into another app.
    ? { tone: 'text-success', text: 'Dictation inserted. Setup is complete.' }
    : !active ? null
      : focused
        ? { tone: 'text-primary', text: 'Ready. If nothing appears, the pill says why. Try again anytime.' }
        : { tone: 'text-muted-foreground', text: 'Click the field so your words land here.' };

  return (
    <div className="mt-4">
      <Textarea
        ref={field}
        aria-label="Practice Dictation field"
        disabled={!active && !completed}
        placeholder="Your words appear here."
        spellCheck={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={cn(
          'min-h-28 resize-none rounded-xl bg-background px-4 py-3 text-[15px] leading-relaxed caret-primary shadow-none duration-150 ease-out md:text-[15px] dark:bg-background motion-reduce:transition-none',
          completed && 'border-success/70 focus-visible:border-success/70 focus-visible:ring-success/30',
        )}
      />
      <p role="status" className={`mt-2 flex min-h-5 items-center gap-1.5 text-[13px] ${status?.tone ?? ''}`}>
        {completed ? <Check className="size-4" aria-hidden="true" /> : null}
        {status?.text}
      </p>
    </div>
  );
}

function ModelState({ state }: { state: ManagedLocalModelState }) {
  if (state.kind === 'downloading') {
    const percent = state.totalBytes > 0 ? Math.round(state.downloadedBytes / state.totalBytes * 100) : 0;
    return (
      <div className="mt-3 space-y-2">
        <Progress value={percent} label="Speech model download" />
        <p className="text-sm" role="status">
          Downloading… {percent}% ({formatBytes(state.downloadedBytes)} of {formatBytes(state.totalBytes)})
        </p>
      </div>
    );
  }
  if (state.kind === 'installing') return <p className="mt-3 text-sm" role="status">Verifying and installing…</p>;
  if (state.kind === 'ready') return <p className="mt-3 text-sm text-success">Installed and ready offline.</p>;
  if (state.kind === 'error') return <p className="mt-3 text-sm text-destructive" role="alert">{state.message}</p>;
  return null;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function actionLabel(action: 'retry' | 'resume' | 'repair'): string {
  if (action === 'resume') return 'Resume download';
  if (action === 'repair') return 'Repair model';
  return 'Retry download';
}
