import { runAgent, type ToolApproval } from './agent';
import { parseAgentActivityLink, type AgentActivityPort, type AgentActivityUpdate } from './agent-activity';
import type { Fetch } from './network';
import { defaultSettings, mobileSettingsSchema, settingsError, type MobileSettings } from './settings';
import { transcribe } from './transcription';

export type RecordingIntent = 'dictation' | 'agent';
export type Phase = 'loading' | 'idle' | 'requestingPermission' | 'recording' | 'transcribing' | 'running' | 'awaitingApproval';
type State = {
  settings: MobileSettings; phase: Phase; intent: RecordingIntent; transcript: string; response: string;
  status: string; error: string | null; approval: PendingApproval | null; recordingStartedAt: number | null;
  runId: string | null; activityNotice: string | null; activityOpenCount: number;
  approvalNotified: boolean;
  approvalReviewId: string | null;
};
type PendingApproval = ToolApproval & { runId: string; approvalId: string };
export type ApprovalDecision = Pick<PendingApproval, 'runId' | 'approvalId'> & { approved: boolean };
export type Recorder = {
  requestPermission(): Promise<boolean>;
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<Blob>;
  discard(): Promise<void>;
};

/** Owns single-flight work independently of React renders and native permission dialogs. */
export class MobileController {
  private state: State = { settings: defaultSettings, phase: 'loading', intent: 'dictation', transcript: '', response: '', status: 'Loading settings…', error: null, approval: null, recordingStartedAt: null, runId: null, activityNotice: null, activityOpenCount: 0, approvalNotified: false, approvalReviewId: null };
  private listeners = new Set<() => void>();
  private active: AbortController | null = null;
  private approvalDecision: ((approved: boolean) => void) | null = null;
  private initialization: Promise<void> | null = null;
  private finishing = false;
  private activityStarted = false;
  private activityUpdates = Promise.resolve();
  private completedSteps = 0;
  private sequence = 0;
  private interrupted = false;
  private backgrounded = false;
  private savedRunId: string | null = null;

  constructor(private readonly ports: {
    recorder: Recorder; fetch: Fetch;
    transcribeOnDevice?(signal: AbortSignal, language: string): Promise<string>;
    signGoogleJwt?(privateKey: string, input: string): Promise<string>;
    loadSettings(): Promise<MobileSettings>;
    saveSettings(settings: MobileSettings): Promise<MobileSettings>;
    activity?: AgentActivityPort;
  }) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<State>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }

  initialize = (): Promise<void> => {
    this.initialization ??= this.load();
    return this.initialization;
  };
  private async load() {
    let settingsLoaded = false;
    try { this.update({ settings: mobileSettingsSchema.parse(await this.ports.loadSettings()) }); settingsLoaded = true; }
    catch { this.update({ error: 'Saved settings could not be loaded. Close and reopen the app, or reset settings to configure it again. Your saved settings have not been replaced.', status: 'Settings unavailable.' }); }
    let status = 'Ready to record.';
    try {
      const recovered = await this.ports.activity?.recover();
      if (recovered) {
        this.savedRunId = recovered.runId;
        status = recovered.phase === 'completed' ? 'Last agent answer restored.' : 'The last agent run stopped. Tools already started may still have finished.';
        this.update({ runId: recovered.runId, response: recovered.response, intent: 'agent' });
      }
    } catch { this.update({ activityNotice: 'Could not restore the last agent result.' }); }
    if (settingsLoaded) this.update({ phase: 'idle', status });
  }

  startRecording = async (intent: RecordingIntent) => {
    if (this.state.phase !== 'idle' || this.active || this.backgrounded) return;
    if (intent === 'agent' && !this.state.settings.agentEnabled) { this.update({ error: 'Enable Agent Mode in Settings first.' }); return; }
    const active = new AbortController();
    this.active = active;
    const previousRunId = this.savedRunId;
    this.activityStarted = false;
    this.interrupted = false;
    this.update({ phase: 'requestingPermission', intent, status: 'Requesting microphone access…', error: null, transcript: '', response: '', runId: null, activityNotice: null });
    try {
      if (previousRunId) {
        try {
          await this.ports.activity?.clear(previousRunId);
          if (this.savedRunId === previousRunId) this.savedRunId = null;
        }
        catch { this.update({ activityNotice: 'Could not clear the previous agent result.' }); }
      }
      active.signal.throwIfAborted();
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
        transcript = (await this.ports.transcribeOnDevice(active.signal, this.state.settings.language)).trim();
        if (!transcript) throw new Error('No speech was recognized. Record again.');
        if (transcript.length > 200_000) throw new Error('The local transcript is too large. Record a shorter clip.');
      } else {
        transcript = await transcribe({ audio, settings: this.state.settings, fetch: this.ports.fetch, signal: active.signal, signGoogleJwt: this.ports.signGoogleJwt });
      }
      active.signal.throwIfAborted();
      this.update({ transcript });
      if (this.state.intent === 'agent') {
        // Agent work can outlive the foreground app; release its audio before requesting background time.
        try { await this.ports.recorder.discard(); }
        catch { throw new Error('Could not remove the temporary recording. The agent did not start.'); }
        active.signal.throwIfAborted();
        await this.agent(active, transcript);
      }
      await this.finish(active);
    } catch (error) { await this.finish(active, error); }
  };

  private async agent(active: AbortController, transcript: string) {
    this.update({ phase: 'running', response: '', status: 'Starting agent…' });
    this.completedSteps = 0;
    this.activityStarted = false;
    let runId = `foreground-${Date.now()}-${++this.sequence}`;
    try {
      const started = await this.ports.activity?.start(24 + this.state.settings.mcpServers.filter(server => server.enabled).length);
      if (started) { runId = started.runId; this.savedRunId = runId; this.activityStarted = true; }
    } catch { this.update({ activityNotice: 'Live Activity unavailable. Keep Shuddhalekhan open to finish this run.' }); }
    this.update({ runId });
    active.signal.throwIfAborted();
    if (this.backgrounded) await this.enterBackground();
    active.signal.throwIfAborted();
    const response = await runAgent({ transcript, settings: this.state.settings, signal: active.signal, fetch: this.ports.fetch,
      onStatus: (status, completedSteps) => {
        if (this.active !== active || active.signal.aborted) return;
        this.completedSteps = completedSteps;
        this.update({ status });
        void this.publish({ runId, phase: 'running', status, completedSteps });
      },
      approve: async approval => {
        active.signal.throwIfAborted();
        const pending = { ...approval, runId, approvalId: `${runId}-${++this.sequence}` };
        const activityUpdate = { runId, phase: 'awaitingApproval', status: 'Approval needed. Open Shuddhalekhan to review.', approvalId: pending.approvalId,
          approvalTitle: `${approval.toolName} · ${approval.serverName}`, completedSteps: this.completedSteps } satisfies AgentActivityUpdate;
        let approvalNotified = false;
        // Commit the native wait before exposing approval, independently of queued display updates.
        if (this.activityStarted) {
          try { approvalNotified = await this.ports.activity?.prepareApproval(activityUpdate) ?? false; }
          catch { throw new Error('Could not prepare this tool approval. The tool was not started.'); }
        }
        active.signal.throwIfAborted();
        const decision = new Promise<boolean>(resolve => {
          this.approvalDecision = resolve;
          this.update({ phase: 'awaitingApproval', approval: pending, approvalNotified, status: 'Waiting for your tool approval…' });
        });
        await this.publish(activityUpdate);
        active.signal.throwIfAborted();
        await this.consumeApprovalAction();
        return decision;
      },
    });
    active.signal.throwIfAborted();
    this.update({ response });
  }

  retryAgent = () => {
    if (this.state.phase !== 'idle' || this.active || this.backgrounded || !this.state.transcript) return;
    const active = new AbortController();
    this.active = active;
    this.interrupted = false;
    this.update({ intent: 'agent', error: null, runId: null, activityNotice: null });
    void this.agent(active, this.state.transcript).then(() => this.finish(active), error => this.finish(active, error));
  };

  resolveApproval = async ({ approved, runId, approvalId }: ApprovalDecision) => {
    const active = this.active;
    const pending = this.state.approval;
    const resolve = this.approvalDecision;
    if (!active || active.signal.aborted || this.backgrounded || !resolve || pending?.runId !== runId || pending.approvalId !== approvalId) return;
    this.approvalDecision = null;
    this.update({ approval: null, approvalNotified: false, phase: 'running' });
    await this.activityUpdates;
    if (this.active !== active || active.signal.aborted) { resolve(false); return; }
    if (approved && this.activityStarted) {
      try { await this.ports.activity?.resume(runId); }
      catch {
        this.interrupted = true;
        this.update({ activityNotice: 'This approval expired or could not be resumed. Start a new command.' });
        this.cancel();
        resolve(false);
        return;
      }
    }
    if (this.active !== active || active.signal.aborted) { resolve(false); return; }
    resolve(approved);
  };

  private publish(update: AgentActivityUpdate): Promise<void> {
    if (!this.activityStarted) return Promise.resolve();
    this.activityUpdates = this.activityUpdates.then(() => this.ports.activity?.update(update)).catch(() => {
      this.update({ activityNotice: 'Live Activity could not update. Open Shuddhalekhan for the current status.' });
    });
    return this.activityUpdates;
  }

  enterBackground = async () => {
    this.backgrounded = true;
    const active = this.active;
    if (!active || active.signal.aborted) return;
    if (this.state.intent === 'agent' && this.state.phase === 'awaitingApproval') return;
    const runId = this.state.runId;
    if (this.state.intent === 'agent' && this.state.phase === 'running' && runId && this.activityStarted) {
      let allowed = false;
      try { allowed = await this.ports.activity?.canContinueInBackground(runId) ?? false; } catch { /* Fall back to foreground execution. */ }
      if (this.active !== active || active.signal.aborted || !this.backgrounded || this.getSnapshot().phase === 'awaitingApproval') return;
      if (allowed) return;
      this.interrupted = true;
      this.update({ activityNotice: 'Background processing stopped. Keep Shuddhalekhan open to finish Agent Mode.' });
    }
    this.cancel();
  };

  enterForeground = async () => {
    this.backgrounded = false;
    if (!this.active || !this.activityStarted) return;
    try {
      const current = await this.ports.activity?.recover();
      if (current?.phase === 'interrupted') this.agentRunStopped(current.runId);
    } catch { /* The live run remains usable; background admission is checked separately. */ }
    await this.consumeApprovalAction();
  };

  consumeApprovalAction = async () => {
    if (this.backgrounded || !this.active || !this.activityStarted) return;
    let action;
    try { action = await this.ports.activity?.takeApprovalAction(); }
    catch { return; }
    const pending = this.state.approval;
    if (this.backgrounded || !action || !pending || action.runId !== pending.runId || action.approvalId !== pending.approvalId) return;
    if (action.action === 'review') this.update({ activityOpenCount: this.state.activityOpenCount + 1, approvalReviewId: action.approvalId });
    else await this.resolveApproval({ ...action, approved: action.action === 'approve' });
  };

  agentRunStopped = (runId: string) => {
    if (!this.active || this.state.runId !== runId) return;
    this.interrupted = true;
    this.cancel();
  };

  openActivity = (value: string): boolean => {
    const link = parseAgentActivityLink(value);
    if (!link || link.runId !== this.state.runId || (link.approvalId !== null && link.approvalId !== this.state.approval?.approvalId)) return false;
    this.update({ activityOpenCount: this.state.activityOpenCount + 1, approvalReviewId: this.state.approval?.approvalId ?? null });
    return true;
  };

  cancel = () => {
    if (!this.active || this.active.signal.aborted) return;
    this.active.abort();
    const resolve = this.approvalDecision;
    this.approvalDecision = null;
    resolve?.(false);
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
    if (this.state.intent === 'agent' && this.state.runId) {
      const base = { runId: this.state.runId, completedSteps: this.completedSteps };
      await this.publish(this.interrupted ? { ...base, phase: 'interrupted', status: 'Run interrupted. Tools already started may still finish.' }
        : active.signal.aborted ? { ...base, phase: 'cancelled', status: 'Run cancelled. Tools already started may still finish.' }
        : error ? { ...base, phase: 'failed', status: 'Agent could not finish. Open Shuddhalekhan for details.' }
        : { ...base, phase: 'completed', status: 'Answer ready.', response: this.state.response.slice(0, 200_000) });
    }
    this.active = null;
    this.finishing = false;
    this.approvalDecision = null;
    this.update({ phase: 'idle', approval: null, approvalNotified: false,
      status: this.interrupted ? 'Interrupted. Tools already started may still finish. Start a new command when ready.' : active.signal.aborted ? 'Cancelled. Tools already started may still finish.' : error ? 'Could not complete the command.' : 'Done.',
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
  clearResults = async () => {
    if (this.state.phase !== 'idle' || this.active) return;
    const savedRunId = this.savedRunId;
    try {
      if (savedRunId) await this.ports.activity?.clear(savedRunId);
      if (this.savedRunId === savedRunId) this.savedRunId = null;
    }
    catch { this.update({ error: 'Could not clear the saved agent result. Try again.' }); return; }
    if (this.state.phase !== 'idle' || this.active) return;
    this.update({ transcript: '', response: '', runId: null, error: null, activityNotice: null, status: 'Ready to record.' });
  };
  dismissError = () => { if (this.state.phase !== 'loading') this.update({ error: null }); };
}
