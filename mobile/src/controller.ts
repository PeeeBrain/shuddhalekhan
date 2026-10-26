import { runAgent, type ToolApproval } from './agent';
import type { Fetch } from './network';
import { defaultSettings, mobileSettingsSchema, settingsError, type MobileSettings } from './settings';
import { transcribe } from './transcription';

export type RecordingIntent = 'dictation' | 'agent';
export type Phase = 'loading' | 'idle' | 'requestingPermission' | 'recording' | 'transcribing' | 'running' | 'awaitingApproval';
type State = {
  settings: MobileSettings; phase: Phase; intent: RecordingIntent; transcript: string; response: string;
  status: string; error: string | null; approval: ToolApproval | null; recordingStartedAt: number | null;
};
export type Recorder = {
  requestPermission(): Promise<boolean>;
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<Blob>;
  discard(): Promise<void>;
};

/** Owns single-flight work independently of React renders and native permission dialogs. */
export class MobileController {
  private state: State = { settings: defaultSettings, phase: 'loading', intent: 'dictation', transcript: '', response: '', status: 'Loading settings…', error: null, approval: null, recordingStartedAt: null };
  private listeners = new Set<() => void>();
  private active: AbortController | null = null;
  private approvalDecision: ((approved: boolean) => void) | null = null;
  private initialization: Promise<void> | null = null;
  private finishing = false;

  constructor(private readonly ports: {
    recorder: Recorder; fetch: Fetch;
    transcribeOnDevice?(signal: AbortSignal): Promise<string>;
    loadSettings(): Promise<MobileSettings>;
    saveSettings(settings: MobileSettings): Promise<MobileSettings>;
  }) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<State>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }

  initialize = (): Promise<void> => {
    this.initialization ??= this.load();
    return this.initialization;
  };
  private async load() {
    try { this.update({ settings: mobileSettingsSchema.parse(await this.ports.loadSettings()), phase: 'idle', status: 'Ready to record.' }); }
    catch { this.update({ error: 'Saved settings could not be loaded. Close and reopen the app, or reset settings to configure it again. Your saved settings have not been replaced.', status: 'Settings unavailable.' }); }
  }

  startRecording = async (intent: RecordingIntent) => {
    if (this.state.phase !== 'idle' || this.active) return;
    if (intent === 'agent' && !this.state.settings.agentEnabled) { this.update({ error: 'Enable Agent Mode in Settings first.' }); return; }
    const active = new AbortController();
    this.active = active;
    this.update({ phase: 'requestingPermission', intent, status: 'Requesting microphone access…', error: null, transcript: '', response: '' });
    try {
      mobileSettingsSchema.parse(this.state.settings);
      const granted = await this.ports.recorder.requestPermission();
      active.signal.throwIfAborted();
      if (!granted) throw new Error('Microphone access is denied. Enable it for Shuddhalekhan in iOS Settings.');
      await this.ports.recorder.start(active.signal);
      active.signal.throwIfAborted();
      this.update({ phase: 'recording', recordingStartedAt: Date.now(), status: intent === 'dictation' ? 'Recording dictation…' : 'Recording agent command…' });
    } catch (error) { await this.finish(active, error); }
  };

  stopRecording = async () => {
    const active = this.active;
    if (!active || this.state.phase !== 'recording' || active.signal.aborted) return;
    this.update({ phase: 'transcribing', status: 'Transcribing…' });
    try {
      const audio = await this.ports.recorder.stop();
      active.signal.throwIfAborted();
      let transcript: string;
      if (this.state.settings.transcriptionSource === 'on-device') {
        if (!this.ports.transcribeOnDevice) throw new Error('On-device Parakeet is unavailable in this build.');
        transcript = (await this.ports.transcribeOnDevice(active.signal)).trim();
        if (!transcript) throw new Error('No speech was recognized. Record again.');
        if (transcript.length > 200_000) throw new Error('The local transcript is too large. Record a shorter clip.');
      } else {
        transcript = await transcribe({ audio, settings: this.state.settings, fetch: this.ports.fetch, signal: active.signal });
      }
      active.signal.throwIfAborted();
      this.update({ transcript });
      if (this.state.intent === 'agent') await this.agent(active, transcript);
      await this.finish(active);
    } catch (error) { await this.finish(active, error); }
  };

  private async agent(active: AbortController, transcript: string) {
    this.update({ phase: 'running', response: '', status: 'Starting agent…' });
    const response = await runAgent({ transcript, settings: this.state.settings, signal: active.signal, fetch: this.ports.fetch,
      onStatus: status => { if (this.active === active && !active.signal.aborted) this.update({ status }); },
      approve: async approval => {
        active.signal.throwIfAborted();
        return new Promise<boolean>(resolve => {
          this.approvalDecision = resolve;
          this.update({ phase: 'awaitingApproval', approval });
        });
      },
    });
    active.signal.throwIfAborted();
    this.update({ response });
  }

  retryAgent = () => {
    if (this.state.phase !== 'idle' || this.active || !this.state.transcript) return;
    const active = new AbortController();
    this.active = active;
    this.update({ intent: 'agent', error: null });
    void this.agent(active, this.state.transcript).then(() => this.finish(active), error => this.finish(active, error));
  };

  resolveApproval = (approved: boolean) => {
    const resolve = this.approvalDecision;
    if (!resolve) return;
    this.approvalDecision = null;
    this.update({ approval: null, phase: 'running' });
    resolve(approved);
  };

  cancel = () => {
    if (!this.active || this.active.signal.aborted) return;
    this.active.abort();
    this.resolveApproval(false);
    this.update({ status: 'Cancelling… A tool already started may still finish.' });
    // Permission/preparation and network operations release their own work before another run starts.
    if (this.state.phase === 'recording') void this.finish(this.active);
  };

  recordingInterrupted = () => {
    if (this.active && this.state.phase === 'recording') {
      void this.finish(this.active, new Error('Recording was interrupted. No audio was sent. Record again.'));
    }
  };

  private async finish(active: AbortController, error?: unknown) {
    if (this.active !== active || this.finishing) return;
    this.finishing = true;
    try { await this.ports.recorder.discard(); }
    catch { if (!error && !active.signal.aborted) error = new Error('Could not remove the temporary recording. It remains in the app cache.'); }
    if (this.active !== active) return;
    this.active = null;
    this.finishing = false;
    this.approvalDecision = null;
    this.update({ phase: 'idle', approval: null,
      status: active.signal.aborted ? 'Cancelled. Tools already started may still finish.' : error ? 'Could not complete the command.' : 'Done.',
      error: active.signal.aborted ? null : error ? settingsError(error) : null,
    });
  }

  saveSettings = async (settings: MobileSettings) => {
    if (this.state.phase !== 'idle' || this.active) throw new Error('Wait for the current command to finish.');
    const parsed = mobileSettingsSchema.parse(settings);
    this.update({ phase: 'loading' });
    try { this.update({ settings: await this.ports.saveSettings(parsed), error: null, status: 'Settings saved.' }); }
    finally { this.update({ phase: 'idle' }); }
  };
  resetSettings = async () => {
    if (this.state.phase !== 'loading' || !this.state.error) return;
    this.update({ error: null, status: 'Resetting settings…' });
    try { this.update({ settings: await this.ports.saveSettings(defaultSettings), phase: 'idle', status: 'Settings reset. Add your provider credentials in Settings.' }); }
    catch { this.update({ error: 'Could not reset saved settings. Restart the app and try again.', status: 'Settings unavailable.' }); }
  };
  clearResults = () => {
    if (this.state.phase !== 'idle' || this.active) return;
    this.update({ transcript: '', response: '', error: null, status: 'Ready to record.' });
  };
  dismissError = () => { if (this.state.phase !== 'loading') this.update({ error: null }); };
}
