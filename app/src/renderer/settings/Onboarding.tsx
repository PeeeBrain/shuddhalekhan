import { useEffect, useRef, useState } from 'react';
import { Check, Download, Mic, Keyboard, ArrowRight, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AppConfig, ManagedLocalModelSnapshot, ManagedLocalModelState } from '../../types/ipc';
import { formatBinding } from '../../shared/shortcut-bindings';
import type { SettingsIpc } from './settings-ipc';

export function Onboarding({
  config,
  settingsIpc,
  onOpenAdvanced,
}: {
  config: AppConfig;
  settingsIpc: SettingsIpc;
  onOpenAdvanced: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ManagedLocalModelSnapshot | null>(null);
  const [micState, setMicState] = useState<'idle' | 'checking' | 'verified' | 'error'>('idle');
  const [micLevel, setMicLevel] = useState(0);
  const [installError, setInstallError] = useState('');
  const micCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    void settingsIpc.getManagedLocalModel().then(setSnapshot).catch(() => {
      setInstallError('Could not check the local speech model. Retry.');
    });
    const offState = settingsIpc.onManagedLocalModelStateChanged((state) => {
      setSnapshot((current) => current ? { ...current, state } : current);
    });
    return () => {
      offState?.();
      micCleanup.current?.();
    };
  }, [settingsIpc]);

  const install = async () => {
    setInstallError('');
    try {
      setSnapshot(await settingsIpc.installManagedLocalModel());
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Model installation failed. Retry.');
      void settingsIpc.getManagedLocalModel().then(setSnapshot);
    }
  };

  const startMicrophoneCheck = async () => {
    setMicState('checking');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const values = new Uint8Array(analyser.frequencyBinCount);
      const timer = window.setInterval(() => {
        analyser.getByteTimeDomainData(values);
        const peak = values.reduce((largest, value) => Math.max(largest, Math.abs(value - 128)), 0);
        setMicLevel(Math.min(1, peak / 64));
      }, 100);
      micCleanup.current = () => {
        window.clearInterval(timer);
        stream.getTracks().forEach((track) => track.stop());
        void context.close();
      };
    } catch {
      setMicState('error');
    }
  };

  const finishMicrophoneCheck = () => {
    micCleanup.current?.();
    micCleanup.current = null;
    setMicState('verified');
    setMicLevel(0);
  };

  const modelReady = snapshot?.state.kind === 'ready';
  const shortcut = formatBinding(config.shortcuts.dictation.binding);

  return (
    <main className="min-h-screen bg-canvas px-6 py-10 text-foreground">
      <div className="mx-auto max-w-2xl">
        <header className="mb-8">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary">Welcome to Shuddhalekhan</p>
          <h1 className="text-3xl font-semibold tracking-tight">Set up Dictation</h1>
          <p className="mt-2 text-sm text-muted-foreground">Install private local speech recognition, check your microphone, then complete one real Dictation.</p>
        </header>

        <div className="space-y-4">
          <Step icon={Download} number="1" title="Install local speech recognition" done={modelReady}>
            {snapshot ? (
              <>
                <p className="font-medium">{snapshot.model.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatBytes(snapshot.model.downloadBytes)} download · {formatBytes(snapshot.model.installedBytes)} installed · {snapshot.model.languages.length} European languages
                </p>
                <ModelState state={snapshot.state} />
                {!modelReady && snapshot.state.kind !== 'downloading' && snapshot.state.kind !== 'installing' ? (
                  <Button className="mt-4" onClick={() => void install()}>
                    {snapshot.state.kind === 'error' ? actionLabel(snapshot.state.action) : 'Download model'}
                  </Button>
                ) : null}
              </>
            ) : <p className="text-sm text-muted-foreground">Checking model status…</p>}
            {installError ? <p role="alert" className="mt-3 text-sm text-destructive">{installError}</p> : null}
          </Step>

          <Step icon={Mic} number="2" title="Check your microphone" done={micState === 'verified'} disabled={!modelReady}>
            <p className="text-sm text-muted-foreground">Shuddhalekhan will use your default Windows input device.</p>
            {micState === 'checking' ? (
              <div className="mt-4">
                <div className="h-2 overflow-hidden rounded-full bg-muted" aria-label="Microphone level">
                  <div className="h-full bg-primary" style={{ width: `${Math.max(4, micLevel * 100)}%` }} />
                </div>
                <p className="mt-2 text-sm">Speak and confirm that the level moves.</p>
                <Button className="mt-3" onClick={finishMicrophoneCheck}>My microphone works</Button>
              </div>
            ) : micState === 'verified' ? (
              <p className="mt-3 text-sm text-emerald-500">Microphone check complete.</p>
            ) : (
              <>
                <Button className="mt-4" disabled={!modelReady} onClick={() => void startMicrophoneCheck()}>Start microphone check</Button>
                {micState === 'error' ? <p role="alert" className="mt-3 text-sm text-destructive">Microphone access failed. Check Windows microphone privacy settings, then retry.</p> : null}
              </>
            )}
          </Step>

          <Step icon={Keyboard} number="3" title="Complete one Dictation" done={false} disabled={micState !== 'verified'}>
            <p className="text-sm text-muted-foreground">Open any text field, then press <strong className="text-foreground">{shortcut}</strong> to start recording. Press it again to stop.</p>
            {micState === 'verified' ? (
              <p className="mt-3 flex items-center gap-2 text-sm font-medium text-primary"><ArrowRight className="size-4" aria-hidden="true" />Waiting for a successful Dictation…</p>
            ) : null}
          </Step>
        </div>

        <button type="button" className="mt-6 inline-flex items-center gap-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={onOpenAdvanced}>
          <Settings className="size-4" aria-hidden="true" />Configure an advanced provider
        </button>
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
        <span className={`flex size-9 items-center justify-center rounded-full ${done ? 'bg-emerald-500/15 text-emerald-500' : 'bg-secondary text-primary'}`}>
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

function ModelState({ state }: { state: ManagedLocalModelState }) {
  if (state.kind === 'downloading') {
    const percent = state.totalBytes > 0 ? Math.round(state.downloadedBytes / state.totalBytes * 100) : 0;
    return <p className="mt-3 text-sm" role="status">Downloading… {percent}%</p>;
  }
  if (state.kind === 'installing') return <p className="mt-3 text-sm" role="status">Verifying and installing…</p>;
  if (state.kind === 'ready') return <p className="mt-3 text-sm text-emerald-500">Installed and ready offline.</p>;
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
