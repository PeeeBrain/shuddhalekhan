import { handle } from './typed-ipc';
import { ipcMain, screen } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { AudioSpool, sweepOrphanedSpools } from './audio-spool';
import type {
  DictationRecoveryAction,
  RecordingIntent,
  RecordingPresentationEnvelope,
  RuntimeAudioCommand,
  RuntimePresentationSnapshot,
  RuntimePresentationState,
} from '../types/ipc';
import { createSingletonWindow } from './window-factory';
import type { SingletonWindowController } from './window-factory';

type ShellWindow = NonNullable<ReturnType<SingletonWindowController['get']>>;

const SHELL_WIDTH = 172;
const SHELL_HEIGHT = 52;
const PREVIEW_WIDTH = 520;
const PREVIEW_HEIGHT = 116;
const FAILURE_WIDTH = 520;
const FAILURE_HEIGHT = 168;
const AGENT_CARD_WIDTH = 520;
const AGENT_STATUS_HEIGHT = 112;
const AGENT_APPROVAL_HEIGHT = 380;
const AGENT_FAILED_HEIGHT = 168;
const AGENT_RESPONSE_BASE_HEIGHT = 200;
const AGENT_RESPONSE_MAX_HEIGHT = 520;
const AGENT_RESIZE_STEP = 18;
const AGENT_STATUS_WINDOW_MS = 3500;
// ponytail: fixed cadence; responses past ~30 KB still parse slower than this, adapt to render cost if that ever matters.
const AGENT_STREAM_PUBLISH_INTERVAL_MS = 100;
const BOTTOM_MARGIN = 48;

/** Point-in-time run activity, e.g. tool progress. Auto-hides after a short window. */
interface AgentStatusFact {
  agentRunId: string | null;
  message: string;
}

/** Latest non-empty cumulative model response for the active run. */
interface AgentStreamFact {
  agentRunId: string;
  response: string;
}

/** One sequential pending approval; expires on the sidecar's schedule. */
interface AgentApprovalFact {
  agentRunId: string;
  approvalId: string;
  serverId: string;
  serverDisplayName?: string;
  toolName: string;
  modelToolName: string;
  arguments: unknown;
  expiresAtMs: number;
}

/** How the run ended; survives Dictation preemption and renderer crashes. */
type AgentTerminalFact =
  | { phase: 'completed'; agentRunId: string; response: string; toolSummary: string[] }
  | { phase: 'failed'; agentRunId: string | null; message: string };

interface DictationFailureFact {
  recordingSessionId: string | null;
  message: string;
  recoveryActions: DictationRecoveryAction[];
}

interface WindowGeometry {
  width: number;
  height: number;
  focusable: boolean;
  interactive: boolean;
}

export interface RecordingHandlers {
  onCrash(reason: string): void;
  onAudioData(event: unknown, generation: number, recordingSessionId: string, sequence: number, audio: ArrayBuffer): Promise<void>;
  onAudioFailed(event: unknown, generation: number, recordingSessionId: string, sequence: number): void;
}

/** Startup-warmed renderer shared by Batch Dictation capture and presentation. */
export class RuntimeShell {
  private ready = false;
  private pendingBegin: RecordingPresentationEnvelope | null = null;
  private activeCommand: RuntimeAudioCommand | null = null;
  /** The active command's canonical audio; lives exactly as long as that command. */
  private spool: AudioSpool | null = null;
  private generation = 1;
  private revision = 0;
  private pendingSnapshot: RuntimePresentationSnapshot | null = null;
  private activeRecording: Extract<RuntimePresentationState, { kind: 'recording' }> | null = null;
  private processingSessionId: string | null = null;
  private dictationFailure: DictationFailureFact | null = null;
  private agentStatus: AgentStatusFact | null = null;
  private agentStream: AgentStreamFact | null = null;
  private agentApproval: AgentApprovalFact | null = null;
  private agentTerminal: AgentTerminalFact | null = null;
  private agentResponseHeight = AGENT_RESPONSE_BASE_HEIGHT;
  private lastPresentedKey: string | null = null;
  private lastGeometry: WindowGeometry | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalTimer: ReturnType<typeof setTimeout> | null = null;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly windows;

  private recordingHandlers: RecordingHandlers | null = null;

  constructor(
    private readonly timers: {
      setTimeoutFn: typeof setTimeout;
      clearTimeoutFn: typeof clearTimeout;
    } = { setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout },
  ) {
    this.windows = createSingletonWindow({
      route: 'runtime',
      options: {
        width: SHELL_WIDTH,
        height: SHELL_HEIGHT,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focusable: false,
        hasShadow: false,
        webPreferences: { backgroundThrottling: false },
      },
      onCreated: (win) => {
        win.webContents.on('did-finish-load', () => {
          if (!this.pendingSnapshot || win.isDestroyed()) return;
          win.webContents.send('runtime:snapshot', this.pendingSnapshot);
          this.pendingSnapshot = null;
        });
        win.webContents.on('did-fail-load', (_event, code, description) => {
          console.error(`Runtime shell failed to load: ${code} ${description}`);
        });
        win.webContents.on('render-process-gone', (_event, details) => {
          if (this.windows.get() === win) this.handleCrash(details.reason);
        });
        win.on('unresponsive', () => {
          if (this.windows.get() === win) this.handleCrash('unresponsive');
        });
      },
    });
    sweepOrphanedSpools();
    handle('runtime:audio-spool', this.handleAudioSpool);
    ipcMain.on('runtime:audio-end', this.handleAudioEnd);
  }

  prepare(): void {
    this.resize(this.windows.create(), { width: SHELL_WIDTH, height: SHELL_HEIGHT, focusable: false, interactive: false });
  }

  setRecordingHandlers(handlers: RecordingHandlers): void {
    this.recordingHandlers = handlers;
  }

  markReady(): void {
    this.ready = true;
    if (this.pendingBegin) {
      const envelope = this.pendingBegin;
      this.pendingBegin = null;
      this.startAudio(envelope);
    }
  }

  beginCapture(envelope?: RecordingPresentationEnvelope): void {
    if (!envelope) return;
    if (!this.ready) {
      this.pendingBegin = envelope;
      return;
    }
    this.startAudio(envelope);
  }

  endCapture(): boolean {
    this.pendingBegin = null;
    if (!this.activeCommand) return false;
    this.send('runtime:audio-stop', this.activeCommand);
    return true;
  }

  cancelCapture(): void {
    this.pendingBegin = null;
    if (!this.activeCommand) return;
    const command = this.activeCommand;
    this.clearCommand();
    this.send('runtime:audio-cancel', command);
  }

  setSelectedDevice(deviceId: string | null): void {
    this.send('audio:recreate-stream', deviceId);
  }

  show(
    intent: RecordingIntent,
    recordingSessionId?: string,
    envelope?: RecordingPresentationEnvelope,
  ): void {
    this.cancelPendingHide();
    // A new Agent recording invalidates the prior run's presentation so stale
    // cards cannot resurface once the recording ends.
    if (intent === 'agent') this.invalidateAgentPresentation();
    const win = this.windows.create();
    if (recordingSessionId && envelope) {
      this.activeRecording = {
        kind: 'recording',
        recordingSessionId,
        intent,
        capabilities: envelope.capabilities,
        captureStartedAt: null,
        durationWarningSeconds: null,
      };
    }
    this.republish();
    const publish = () => {
      if (win.isDestroyed()) return;
      win.webContents.send('recording:pill-show');
      if (!win.isVisible()) win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
    };
    if (win.webContents.isLoading()) win.once('ready-to-show', publish);
    else publish();
  }

  hide(): void {
    this.send('recording:pill-hide');
    const win = this.windows.get();
    if (!win || win.isDestroyed()) return;
    this.hideTimer = this.timers.setTimeoutFn(() => {
      if (!win.isDestroyed()) win.hide();
      this.hideTimer = null;
    }, 100);
  }

  showStreamingPreview(
    recordingSessionId: string,
    committed: string,
    tentative: string,
  ): void {
    if (this.activeRecording?.recordingSessionId !== recordingSessionId) return;
    if (
      this.activeRecording.committed === committed
      && this.activeRecording.tentative === tentative
    ) return;
    this.activeRecording = {
      ...this.activeRecording,
      committed,
      tentative,
    };
    this.republish();
  }

  showProcessing(recordingSessionId: string): void {
    this.activeRecording = null;
    this.processingSessionId = recordingSessionId;
    this.dictationFailure = null;
    this.send('recording:pill-hide');
    this.republish();
  }

  showFailure(
    recordingSessionId: string | null,
    message: string,
    recoveryActions: DictationRecoveryAction[] = [],
  ): void {
    this.activeRecording = null;
    this.processingSessionId = null;
    this.send('recording:pill-hide');
    this.dictationFailure = {
      recordingSessionId,
      message,
      recoveryActions,
    };
    this.republish();
  }

  finish(): void {
    this.clearCommand();
    this.activeRecording = null;
    this.processingSessionId = null;
    this.dictationFailure = null;
    this.send('recording:pill-hide');
    this.republish();
  }

  /** Clears Agent presentation silently when a run is cancelled or replaced. */
  clearAgentRun(): void {
    this.invalidateAgentPresentation();
    this.republish();
  }

  showAgentStatus(agentRunId: string | null, message: string): void {
    this.clearAgentTimer('status');
    // Status only arrives between model steps; a still-pending approval would
    // have blocked the loop, so any status proves the approval window closed.
    this.closePendingApproval();
    this.agentStatus = { agentRunId, message };
    this.statusTimer = this.timers.setTimeoutFn(() => {
      this.statusTimer = null;
      if (!this.agentStatus) return;
      this.agentStatus = null;
      this.republish();
    }, AGENT_STATUS_WINDOW_MS);
    this.republish();
  }

  showAgentStreaming(agentRunId: string, response: string): void {
    // Blank streamed prefixes are never a user-facing response.
    if (!response.trim()) return;
    this.clearAgentTimer('status');
    const closesApproval = this.agentApproval !== null;
    this.closePendingApproval();
    // Model output supersedes any point-in-time status.
    this.agentStatus = null;
    const previousResponsePhase = this.presentedResponsePhase();
    if (!previousResponsePhase) this.agentResponseHeight = AGENT_RESPONSE_BASE_HEIGHT;
    this.agentStream = { agentRunId, response };
    // Every delta carries the whole response, and each publish re-sends and
    // re-parses it, so tokens coalesce: publish now, then at most once per interval.
    if (this.streamTimer && !closesApproval) return;
    this.republish();
    if (this.streamTimer) return;
    this.streamTimer = this.timers.setTimeoutFn(() => {
      this.streamTimer = null;
      this.republish();
    }, AGENT_STREAM_PUBLISH_INTERVAL_MS);
  }

  showAgentApproval(approval: {
    agentRunId: string;
    approvalId: string;
    serverId: string;
    serverDisplayName?: string;
    toolName: string;
    modelToolName: string;
    arguments: unknown;
    expiresAt: string;
  }): void {
    const expiresAtMs = new Date(approval.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs)) return;

    this.clearAgentTimer('status');
    this.clearAgentTimer('approval');
    // An approval supersedes point-in-time status but keeps the live stream
    // alive beneath it, so resolving or expiring never flashes empty state.
    this.agentStatus = null;
    const approvalFact = {
      agentRunId: approval.agentRunId,
      approvalId: approval.approvalId,
      serverId: approval.serverId,
      ...(approval.serverDisplayName ? { serverDisplayName: approval.serverDisplayName } : {}),
      toolName: approval.toolName,
      modelToolName: approval.modelToolName,
      arguments: approval.arguments,
      expiresAtMs,
    };
    this.agentApproval = approvalFact;
    const delay = Math.max(0, expiresAtMs - Date.now());
    this.approvalTimer = this.timers.setTimeoutFn(() => {
      if (this.agentApproval !== approvalFact) return;
      this.approvalTimer = null;
      this.agentApproval = null;
      this.republish();
    }, delay);
    this.republish();
  }

  showAgentCompleted(agentRunId: string, response: string, toolSummary: string[]): void {
    this.clearAgentTimers();
    this.agentStatus = null;
    this.agentStream = null;
    this.agentApproval = null;
    this.agentResponseHeight = AGENT_RESPONSE_BASE_HEIGHT;
    this.agentTerminal = {
      phase: 'completed',
      agentRunId,
      response,
      toolSummary,
    };
    this.republish();
  }

  showAgentFailed(agentRunId: string | null, message: string): void {
    this.clearAgentTimers();
    this.agentStatus = null;
    this.agentStream = null;
    this.agentApproval = null;
    this.agentResponseHeight = AGENT_RESPONSE_BASE_HEIGHT;
    this.agentTerminal = {
      phase: 'failed',
      agentRunId,
      message,
    };
    this.republish();
  }

  /** The approval currently presented, so main can act on its server and tool. */
  getPendingApproval(approvalId: string): { serverId: string; toolName: string } | null {
    const approval = this.agentApproval;
    return approval?.approvalId === approvalId
      ? { serverId: approval.serverId, toolName: approval.toolName }
      : null;
  }

  dismissAgentCard(): void {
    if (!this.agentTerminal) return;
    this.agentTerminal = null;
    this.republish();
  }

  /** Applies renderer-measured content growth for streamed/completed cards. */
  handleAgentCardSize(contentHeight: number): void {
    if (!Number.isFinite(contentHeight)) return;
    const state = this.derive();
    const presentingCompleted = state.kind === 'agent-completed';
    if (!presentingCompleted && state.kind !== 'agent-streaming') return;
    const nextContentHeight = Math.min(
      AGENT_RESPONSE_MAX_HEIGHT,
      Math.max(AGENT_RESPONSE_BASE_HEIGHT, Math.ceil(contentHeight)),
    );
    if (!presentingCompleted && nextContentHeight <= this.agentResponseHeight + AGENT_RESIZE_STEP) {
      return;
    }
    if (presentingCompleted && nextContentHeight < this.agentResponseHeight) {
      return;
    }
    this.agentResponseHeight = Math.max(this.agentResponseHeight, nextContentHeight);
    const win = this.windows.get();
    if (!win || win.isDestroyed()) return;
    this.applyGeometry(win, state);
  }

  updateDurationWarning(remainingSeconds: number | null): void {
    if (!this.activeRecording) return;
    this.activeRecording.durationWarningSeconds = remainingSeconds;
    this.republish();
  }

  getWebContents(): WebContents | null {
    const win = this.windows.get();
    return win && !win.isDestroyed() ? win.webContents : null;
  }

  markCaptureReady(recordingSessionId: string): void {
    if (this.activeRecording?.recordingSessionId !== recordingSessionId
      || this.activeRecording.captureStartedAt !== null) return;
    this.activeRecording.captureStartedAt = Date.now();
    this.republish();
  }

  acceptsAudioEvent(generation: number, recordingSessionId: string, sequence: number): boolean {
    return this.activeCommand?.generation === generation
      && this.activeCommand.recordingSessionId === recordingSessionId
      && this.activeCommand.sequence === sequence;
  }

  consumeAudioEvent(generation: number, recordingSessionId: string, sequence: number): boolean {
    if (!this.acceptsAudioEvent(generation, recordingSessionId, sequence)) return false;
    this.clearCommand();
    return true;
  }

  destroy(): void {
    ipcMain.removeHandler('runtime:audio-spool');
    ipcMain.off('runtime:audio-end', this.handleAudioEnd);
    this.cancelPendingHide();
    this.clearAgentTimers();
    this.ready = false;
    this.pendingBegin = null;
    this.clearCommand();
    this.activeRecording = null;
    this.processingSessionId = null;
    this.dictationFailure = null;
    this.agentStatus = null;
    this.agentStream = null;
    this.agentApproval = null;
    this.agentTerminal = null;
    this.windows.destroy();
  }

  private derive(): RuntimePresentationState {
    if (this.activeRecording) return this.activeRecording;
    if (this.processingSessionId) {
      return { kind: 'processing', recordingSessionId: this.processingSessionId };
    }
    if (this.dictationFailure) {
      return {
        kind: 'failure',
        recordingSessionId: this.dictationFailure.recordingSessionId,
        message: this.dictationFailure.message,
        recoveryActions: this.dictationFailure.recoveryActions,
      };
    }

    if (this.agentApproval) {
      const approval = this.agentApproval;
      return {
        kind: 'agent-approval',
        agentRunId: approval.agentRunId,
        approvalId: approval.approvalId,
        serverId: approval.serverId,
        ...(approval.serverDisplayName ? { serverDisplayName: approval.serverDisplayName } : {}),
        toolName: approval.toolName,
        modelToolName: approval.modelToolName,
        arguments: approval.arguments,
        expiresAt: new Date(approval.expiresAtMs).toISOString(),
      };
    }

    const terminal = this.newestTerminal();
    if (terminal) return terminal;

    if (this.agentStream) {
      return { kind: 'agent-streaming', ...this.agentStream };
    }
    if (this.agentStatus) {
      return { kind: 'agent-status', ...this.agentStatus };
    }
    return { kind: 'idle' };
  }

  private newestTerminal(): RuntimePresentationState | null {
    const agent = this.agentTerminal;
    if (agent?.phase === 'completed') {
      return { kind: 'agent-completed', agentRunId: agent.agentRunId, response: agent.response, toolSummary: agent.toolSummary };
    }
    if (agent?.phase === 'failed') {
      return { kind: 'agent-failed', agentRunId: agent.agentRunId, message: agent.message };
    }
    return null;
  }

  /**
   * Presents the single derived snapshot: dedupes unchanged states, applies the
   * native geometry/focus policy for the derived kind, then publishes with a
   * monotonic revision.
   */
  private republish(): void {
    const state = this.derive();
    this.cancelPendingHide();
    const key = JSON.stringify(state);
    if (key === this.lastPresentedKey) return;
    this.lastPresentedKey = key;
    const win = this.windows.get();
    if (state.kind === 'idle') {
      this.lastGeometry = null;
      this.send('recording:pill-hide');
      if (win && !win.isDestroyed()) win.hide();
      this.publish(state);
      return;
    }
    if (win && !win.isDestroyed()) this.applyGeometry(win, state);
    this.showPassive();
    this.publish(state);
  }

  private applyGeometry(win: ShellWindow, state: RuntimePresentationState): void {
    const geometry = this.geometryFor(state);
    const last = this.lastGeometry;
    if (
      last
      && last.width === geometry.width
      && last.height === geometry.height
      && last.focusable === geometry.focusable
      && last.interactive === geometry.interactive
    ) return;
    this.lastGeometry = geometry;
    this.resize(win, geometry);
  }

  private geometryFor(state: RuntimePresentationState): WindowGeometry {
    switch (state.kind) {
      case 'idle':
        return { width: SHELL_WIDTH, height: SHELL_HEIGHT, focusable: false, interactive: false };
      case 'recording': {
        const expanded = state.committed !== undefined
          || state.tentative !== undefined;
        return expanded
          ? { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, focusable: false, interactive: false }
          : { width: SHELL_WIDTH, height: SHELL_HEIGHT, focusable: false, interactive: false };
      }
      case 'processing':
        return { width: SHELL_WIDTH, height: SHELL_HEIGHT, focusable: false, interactive: false };
      case 'failure':
        return {
          width: FAILURE_WIDTH,
          height: FAILURE_HEIGHT,
          focusable: false,
          interactive: state.recoveryActions.length > 0,
        };
      case 'agent-status':
      case 'agent-streaming':
      case 'agent-completed':
        // Pointer input stays enabled so long responses scroll and controls
        // receive clicks; focusable remains false so cards never steal focus.
        return {
          width: AGENT_CARD_WIDTH,
          height: state.kind === 'agent-status'
            ? AGENT_STATUS_HEIGHT
            : Math.min(this.agentResponseHeight, AGENT_RESPONSE_MAX_HEIGHT),
          focusable: false,
          interactive: true,
        };
      case 'agent-approval':
        // Approval controls accept deliberate clicks and keyboard input, but
        // the card never activates on its own.
        return { width: AGENT_CARD_WIDTH, height: AGENT_APPROVAL_HEIGHT, focusable: true, interactive: true };
      case 'agent-failed':
        return { width: AGENT_CARD_WIDTH, height: AGENT_FAILED_HEIGHT, focusable: false, interactive: true };
      default: {
        const _exhaustive: never = state;
        return _exhaustive;
      }
    }
  }

  private resize(win: ShellWindow, geometry: WindowGeometry): void {
    const display = screen.getPrimaryDisplay();
    const x = display.workArea.x + Math.max(0, (display.workArea.width - geometry.width) / 2);
    const y = display.workArea.y + Math.max(0, display.workArea.height - geometry.height - BOTTOM_MARGIN);
    win.setFocusable(geometry.focusable);
    win.setIgnoreMouseEvents(!geometry.interactive, { forward: !geometry.interactive });
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: geometry.width, height: geometry.height }, false);
  }

  private publish(state: RuntimePresentationState): void {
    this.revision += 1;
    const snapshot = {
      ...state,
      generation: this.generation,
      revision: this.revision,
    } as RuntimePresentationSnapshot;
    const win = this.windows.get();
    if (!win || win.isDestroyed() || win.webContents.isLoading()) {
      this.pendingSnapshot = snapshot;
      return;
    }
    win.webContents.send('runtime:snapshot', snapshot);
  }

  private showPassive(): void {
    const win = this.windows.get();
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
  }

  private cancelPendingHide(): void {
    if (!this.hideTimer) return;
    this.timers.clearTimeoutFn(this.hideTimer);
    this.hideTimer = null;
  }

  private presentedResponsePhase(): 'streaming' | 'completed' | null {
    if (this.agentApproval === null && this.agentStream !== null) return 'streaming';
    if (this.agentTerminal?.phase === 'completed') return 'completed';
    return null;
  }

  private invalidateAgentPresentation(): void {
    this.clearAgentTimers();
    this.agentStatus = null;
    this.agentStream = null;
    this.agentApproval = null;
    this.agentTerminal = null;
    this.agentResponseHeight = AGENT_RESPONSE_BASE_HEIGHT;
  }

  private clearAgentTimers(): void {
    this.clearAgentTimer('status');
    this.clearAgentTimer('approval');
    this.clearAgentTimer('stream');
  }

  /** Retires a pending approval once later run activity proves it resolved. */
  private closePendingApproval(): void {
    if (!this.agentApproval) return;
    this.clearAgentTimer('approval');
    this.agentApproval = null;
  }

  private clearAgentTimer(timer: 'status' | 'approval' | 'stream'): void {
    const key = `${timer}Timer` as const;
    const existing = this[key];
    if (!existing) return;
    this.timers.clearTimeoutFn(existing);
    this[key] = null;
  }

  private send(channel: string, ...args: unknown[]): void {
    const webContents = this.getWebContents();
    webContents?.send(channel, ...args);
  }

  private clearCommand(): void {
    this.activeCommand = null;
    this.spool?.discard();
    this.spool = null;
  }

  /**
   * Appends one renderer PCM batch for the active command, in order. The
   * returned acknowledgement returns the batch's worklet credit; false makes
   * the renderer fail the capture.
   */
  private readonly handleAudioSpool = (
    event: IpcMainInvokeEvent,
    generation: number,
    recordingSessionId: string,
    commandSequence: number,
    chunkSequence: number,
    pcm: unknown,
  ): boolean => {
    if (event.sender !== this.getWebContents()) return false;
    if (!this.acceptsAudioEvent(generation, recordingSessionId, commandSequence)) return false;
    if (!(pcm instanceof ArrayBuffer)) {
      this.failCapture(event, new Error('Audio chunk is not binary.'));
      return false;
    }
    const data = new Uint8Array(pcm);
    try {
      this.spool ??= AudioSpool.open();
      this.spool.append(chunkSequence, data);
      return true;
    } catch (error) {
      this.failCapture(event, error);
      return false;
    } finally {
      data.fill(0);
    }
  };

  /**
   * The renderer's acknowledged end boundary. Only a spool holding exactly the
   * declared chunks/samples becomes a WAV delivered to the recording session.
   */
  private readonly handleAudioEnd = (
    event: IpcMainEvent,
    generation: number,
    recordingSessionId: string,
    commandSequence: number,
    chunkCount: number,
    sampleCount: number,
  ): void => {
    if (event.sender !== this.getWebContents()) return;
    if (!this.acceptsAudioEvent(generation, recordingSessionId, commandSequence)) return;
    let wav: Uint8Array<ArrayBuffer>;
    try {
      wav = (this.spool ?? AudioSpool.open()).finish(chunkCount, sampleCount);
    } catch (error) {
      this.failCapture(event, error);
      return;
    } finally {
      this.spool = null;
    }
    const command = this.activeCommand;
    void this.recordingHandlers?.onAudioData(event, generation, recordingSessionId, commandSequence, wav.buffer);
    // The end boundary retires the command even if no consumer claimed it.
    if (this.activeCommand === command) this.clearCommand();
  };

  /** Recoverable capture failure (e.g. disk full, lost chunk): drop audio, release the mic, report once. */
  private failCapture(event: IpcMainEvent | IpcMainInvokeEvent, error: unknown): void {
    const command = this.activeCommand;
    if (!command) return;
    console.error('Audio capture spool failed:', error);
    this.spool?.discard();
    this.spool = null;
    this.send('runtime:audio-cancel', command);
    this.recordingHandlers?.onAudioFailed(event, command.generation, command.recordingSessionId, command.sequence);
    if (this.activeCommand === command) this.clearCommand();
  }

  private startAudio(envelope: RecordingPresentationEnvelope): void {
    this.clearCommand();
    this.activeCommand = {
      generation: this.generation,
      recordingSessionId: envelope.recordingSessionId,
      sequence: envelope.sequence,
      streaming: envelope.streamingActive === true,
    };
    this.send('runtime:audio-start', this.activeCommand);
  }

  private handleCrash(reason: string): void {
    this.ready = false;
    this.pendingBegin = null;
    this.clearCommand();
    this.activeRecording = null;
    this.generation += 1;
    this.revision = 0;
    this.lastPresentedKey = null;
    this.lastGeometry = null;
    this.pendingSnapshot = null;
    // Agent presentation facts survive the renderer: main owns them, and the
    // recreated renderer replays the latest derived snapshot.
    this.windows.destroy();
    this.prepare();
    if (this.derive().kind !== 'idle') this.republish();
    this.recordingHandlers?.onCrash(reason);
  }
}
