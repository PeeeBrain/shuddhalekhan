import { screen } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
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
const FAILURE_HEIGHT = 220;
const AGENT_CARD_WIDTH = 520;
const AGENT_STATUS_HEIGHT = 112;
const AGENT_APPROVAL_HEIGHT = 380;
const AGENT_FAILED_HEIGHT = 248;
const AGENT_RESPONSE_BASE_HEIGHT = 200;
const AGENT_RESPONSE_MAX_HEIGHT = 520;
const AGENT_RESIZE_STEP = 18;
const AGENT_STATUS_WINDOW_MS = 3500;
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
  | { phase: 'completed'; order: number; agentRunId: string; response: string; toolSummary: string[] }
  | { phase: 'failed'; order: number; agentRunId: string | null; message: string };

interface DictationFailureFact {
  order: number;
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

/** Startup-warmed renderer shared by Batch Dictation capture and presentation. */
export class RuntimeShell {
  private ready = false;
  private pendingBegin: RecordingPresentationEnvelope | null = null;
  private activeCommand: RuntimeAudioCommand | null = null;
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
  private nextFactOrder = 1;
  private agentResponseHeight = AGENT_RESPONSE_BASE_HEIGHT;
  private lastPresentedKey: string | null = null;
  private lastGeometry: WindowGeometry | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly windows;

  constructor(
    private onCrash?: (reason: string) => void,
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
          this.handleCrash(details.reason);
        });
      },
    });
  }

  prepare(): void {
    this.position(this.windows.create());
  }

  setCrashHandler(handler: (reason: string) => void): void {
    this.onCrash = handler;
  }

  markReady(): void {
    this.ready = true;
    if (this.pendingBegin) {
      const envelope = this.pendingBegin;
      this.pendingBegin = null;
      this.startAudio(envelope);
    }
  }

  markCrashed(reason: string): void {
    this.handleCrash(reason);
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
    this.endCapture();
  }

  setSelectedDevice(deviceId: string | null): void {
    this.ready = false;
    this.pendingBegin = null;
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
    this.position(win);
    if (recordingSessionId && envelope) {
      this.activeRecording = {
        kind: 'recording',
        recordingSessionId,
        intent,
        capabilities: envelope.capabilities,
        durationWarningSeconds: null,
      };
    }
    this.republish();
    const publish = () => {
      if (win.isDestroyed()) return;
      win.webContents.send('recording:pill-show', recordingSessionId, envelope);
      win.webContents.send('recording:mode-changed', intent);
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
      && !this.activeRecording.insertionHalted
    ) return;
    this.activeRecording = {
      ...this.activeRecording,
      committed,
      tentative,
      insertionHalted: this.activeRecording.insertionHalted === true,
    };
    this.republish();
  }

  showInsertionHalted(recordingSessionId: string): void {
    if (this.activeRecording?.recordingSessionId !== recordingSessionId) return;
    this.activeRecording = { ...this.activeRecording, insertionHalted: true };
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
      order: this.nextFactOrder++,
      recordingSessionId,
      message,
      recoveryActions,
    };
    this.republish();
  }

  finish(): void {
    this.activeCommand = null;
    this.activeRecording = null;
    this.processingSessionId = null;
    this.dictationFailure = null;
    this.send('recording:pill-hide');
    this.republish();
  }

  /** Invalidates any surviving Agent presentation before a new run starts. */
  beginAgentRun(): void {
    this.invalidateAgentPresentation();
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
    this.closePendingApproval();
    // Model output supersedes any point-in-time status.
    this.agentStatus = null;
    const previousResponsePhase = this.presentedResponsePhase();
    if (!previousResponsePhase) this.agentResponseHeight = AGENT_RESPONSE_BASE_HEIGHT;
    this.agentStream = { agentRunId, response };
    this.republish();
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
      this.approvalTimer = null;
      if (this.agentApproval !== approvalFact) return;
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
      order: this.nextFactOrder++,
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
      order: this.nextFactOrder++,
      agentRunId,
      message,
    };
    this.republish();
  }

  dismissAgentCard(): void {
    if (!this.agentTerminal) return;
    this.agentTerminal = null;
    this.republish();
  }

  /** Applies renderer-measured content growth for streamed/completed cards. */
  handleAgentCardSize(contentHeight: number): void {
    if (!Number.isFinite(contentHeight)) return;
    const presentingCompleted = this.agentTerminal?.phase === 'completed' && !this.hasActiveTransients();
    const streaming = this.agentApproval === null && this.agentStream !== null;
    if (!presentingCompleted && !streaming) return;
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
    this.applyGeometry(win, this.derive());
  }

  updateDurationWarning(remainingSeconds: number | null): void {
    this.send('recording:duration-warning', remainingSeconds);
  }

  updateAudioLevel(level: number): void {
    this.send('audio:level-changed', level);
  }

  getWebContents(): WebContents | null {
    const win = this.windows.get();
    return win && !win.isDestroyed() ? win.webContents : null;
  }

  acceptsAudioEvent(generation: number, recordingSessionId: string, sequence: number): boolean {
    return this.activeCommand?.generation === generation
      && this.activeCommand.recordingSessionId === recordingSessionId
      && this.activeCommand.sequence === sequence;
  }

  consumeAudioEvent(generation: number, recordingSessionId: string, sequence: number): boolean {
    if (!this.acceptsAudioEvent(generation, recordingSessionId, sequence)) return false;
    this.activeCommand = null;
    return true;
  }

  destroy(): void {
    this.cancelPendingHide();
    this.clearAgentTimers();
    this.ready = false;
    this.pendingBegin = null;
    this.activeCommand = null;
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
    if (this.processingSessionId) {
      return { kind: 'processing', recordingSessionId: this.processingSessionId };
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
    const candidates: Array<{ order: number; state: RuntimePresentationState }> = [];
    if (this.dictationFailure) {
      candidates.push({
        order: this.dictationFailure.order,
        state: {
          kind: 'failure',
          recordingSessionId: this.dictationFailure.recordingSessionId,
          message: this.dictationFailure.message,
          recoveryActions: this.dictationFailure.recoveryActions,
        },
      });
    }
    const agent = this.agentTerminal;
    if (agent?.phase === 'completed') {
      candidates.push({
        order: agent.order,
        state: {
          kind: 'agent-completed',
          agentRunId: agent.agentRunId,
          response: agent.response,
          toolSummary: agent.toolSummary,
        },
      });
    }
    if (agent?.phase === 'failed') {
      candidates.push({
        order: agent.order,
        state: { kind: 'agent-failed', agentRunId: agent.agentRunId, message: agent.message },
      });
    }
    if (candidates.length === 0) return null;
    return candidates.reduce((newest, candidate) => (candidate.order > newest.order ? candidate : newest)).state;
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
          || state.tentative !== undefined
          || state.insertionHalted === true;
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

  private position(win: Pick<BrowserWindow, 'setPosition'>): void {
    const { workArea, workAreaSize } = screen.getPrimaryDisplay();
    const x = workArea.x + Math.max(0, (workAreaSize.width - SHELL_WIDTH) / 2);
    const y = workArea.y + Math.max(0, workAreaSize.height - SHELL_HEIGHT - BOTTOM_MARGIN);
    win.setPosition(Math.round(x), Math.round(y));
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

  private hasActiveTransients(): boolean {
    return this.agentStatus !== null
      || this.agentStream !== null
      || this.agentApproval !== null;
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
  }

  /** Retires a pending approval once later run activity proves it resolved. */
  private closePendingApproval(): void {
    if (!this.agentApproval) return;
    this.clearAgentTimer('approval');
    this.agentApproval = null;
  }

  private clearAgentTimer(timer: 'status' | 'approval'): void {
    const existing = timer === 'status' ? this.statusTimer : this.approvalTimer;
    if (!existing) return;
    this.timers.clearTimeoutFn(existing);
    if (timer === 'status') this.statusTimer = null;
    else this.approvalTimer = null;
  }

  private send(channel: string, ...args: unknown[]): void {
    const webContents = this.getWebContents();
    webContents?.send(channel, ...args);
  }

  private startAudio(envelope: RecordingPresentationEnvelope): void {
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
    this.activeCommand = null;
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
    this.onCrash?.(reason);
  }
}
