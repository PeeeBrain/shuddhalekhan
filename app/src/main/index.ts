import { randomUUID } from 'crypto';
import { join } from 'path';
import { app, dialog, ipcMain, session, shell, Notification, powerMonitor } from 'electron';

import { getSettingsWindow, openSettingsWindow, setSettingsWindowClosedHandler } from './settings-window';
import { createTray, updateAudioDevices, updateShortcutPauseState, updateUpdaterStatus } from './tray';
import {
  getConfig,
  getChatGptHostId,
  setChatGptHostId,
  getLastSeenReleaseNotesVersion,
  mergeDiscoveredTools,
  setConfig,
  patchTranscriptionConfig,
  setLastSeenReleaseNotesVersion,
} from './config';
import { credentialVault } from './credential-vault';
import { registerCredentialIpcHandlers } from './credential-ipc';
import { getAgentSidecarApiKey } from './agent-credential';
import { ChatGptAuth } from './chatgpt-auth';
import { loadAppIcon } from './app-icon';
import { failedProviderTest, normalizeAgentProvider } from '../shared/agent-provider';
import { agentProviderSchema, resolveAgentProviderKey } from '../shared/agent-provider-validation';
import type { AgentProviderConfig } from '../types/ipc';
import { setupUpdater, checkForUpdates, getUpdateStatus } from './updater';
import { getBundledReleaseNotes, getReleaseNotesPreview } from './release-notes';
import { AgentSidecarManager } from './agent-sidecar';
import { RecordingSession } from './recording-session';
import { keyboardHook } from './native/keyboard';
import {
  checkServerReachability,
  getSafeTranscriptionFailureMessage,
  TranscriptionFailure,
  validateProviderReadiness,
} from './transcription';
import { getTranscriber } from './providers';
import { resolveRecognitionSettings } from '../shared/transcription-features';
import { checkWhisperLiveKitReadiness } from './whisper-live-kit';
import { createSidecarEventRouter } from './sidecar-event-router';
import { McpStatusStore } from './mcp-status-store';
import { makeMcpToolPolicyKey } from '@shuddhalekhan/shared/mcp';
import { getSidecarConfigAction } from './sidecar-config-policy';
import { injectIntoFocusedApp, copyLastTranscriptToClipboard } from './inject-text';
import {
  getLastTranscript,
  markLastTranscriptInjected,
  setLastTranscript,
} from './last-transcript';
import { getAuditRuns, getAuditRunDetail, closeDb } from './audit-db';
import type { AgentApprovalChoice, AppConfig, AudioDevice, InjectResult, McpStatusSnapshot, McpToolPolicyKey, UpdateStatus } from '../types/ipc';
import type { RecordingResult } from './recording-session';
import { createRuntimeReadinessBarrier } from './runtime-readiness';
import { RuntimeShell } from './runtime-shell';
import { createRuntimeShellPresenter } from './agent-presentation';
import { getRecoveryActions } from './dictation-recovery';
import { getPersistentStoreDirectory, preparePersistentStoreDirectory } from './store-path';
import { registerAgentContextIpcHandlers } from './agent-context';
import {
  configureManagedLocal,
  getManagedLocalModelManager,
  managedLocalTranscriber,
  managedLocalSnapshot,
  installManagedLocalModel,
  deleteManagedLocalModel,
} from './managed-local';
import { applyDictationFormatter } from './dictation-formatter';
import { getDictationFormatterApiKey } from './dictation-formatter-credential';
import { getAutomaticDeliveryError, isKdeWaylandSession, isWaylandSession } from './dictation-delivery-policy';
import type { DesktopStatus } from '../shared/desktop-status';
import { prepareDevelopmentIdentity } from './desktop/dev-identity';
import { createKdeFocusTracker } from './desktop/kde-focus';
import { createRemoteDesktopKeyboard } from './desktop/remote-desktop-keyboard';
import { BEST_EFFORT_DISCLOSURE, KdeWaylandDelivery } from './kde-wayland-delivery';
import { captureForegroundTarget } from './native/target';
import { resolvePasteStrategy } from './paste-strategy';

let desktopShortcuts: DesktopStatus['shortcuts'] = process.platform === 'win32'
  ? { backend: 'windows' } : { backend: 'initializing' };

/** Opt-in KDE Wayland test mode; null everywhere else, which keeps Wayland copy-only. */
const waylandDelivery = isKdeWaylandSession(process.platform, process.env) ? new KdeWaylandDelivery({
  createTracker: () => createKdeFocusTracker(publishDesktopStatus),
  createKeyboard: () => createRemoteDesktopKeyboard(publishDesktopStatus),
  waitForShortcutRelease: signal => keyboardHook.waitForShortcutDeactivation(signal),
  stageClipboard: copyLastTranscriptToClipboard,
  getPasteStrategy: appId => resolvePasteStrategy(appId, getConfig().pasteStrategy),
  onChange: publishDesktopStatus,
}) : null;

function getDesktopStatus(): DesktopStatus {
  const bestEffortReady = waylandDelivery?.isReady() ?? false;
  const deliveryError = getAutomaticDeliveryError(process.platform, process.env, bestEffortReady);
  return {
    shortcuts: desktopShortcuts,
    delivery: {
      available: !deliveryError,
      message: deliveryError ?? (bestEffortReady ? BEST_EFFORT_DISCLOSURE
        : 'Final text is pasted after checking the original window. A window check cannot identify changes between fields in the same window.'),
    },
    waylandInsertion: !isWaylandSession(process.platform, process.env) ? undefined : waylandDelivery?.status()
      ?? { state: 'unsupported', message: 'Best-effort insertion is available only on KDE Plasma. Copy finished transcripts from Last Transcript.' },
  };
}

function publishDesktopStatus(): void {
  getSettingsWindow()?.webContents.send('desktop:status-changed', getDesktopStatus());
}

/** Persists the opt-in only once setup actually succeeded, so a declined prompt never re-prompts at launch. */
async function setWaylandInsertion(enabled: boolean): Promise<void> {
  if (!waylandDelivery) return;
  if (!enabled) {
    setConfig('waylandBestEffortInsertion', false);
    await waylandDelivery.disable();
    return;
  }
  const outcome = await waylandDelivery.enable();
  if (outcome !== 'superseded') setConfig('waylandBestEffortInsertion', outcome === 'ready');
}

let cachedAgentEnabled = getConfig().agent.enabled;
let activeAgentRunId: string | null = null;
let providerTestRevision = 0;
let retryPasteInFlight = false;
const runtimeShell = new RuntimeShell();
const agentPresenter = createRuntimeShellPresenter(runtimeShell);
const runtimeReadiness = createRuntimeReadinessBarrier(() => {
  queueMicrotask(() => {
    if (getConfig().transcription.activeProvider === 'managed-local') {
      void managedLocalTranscriber.warmup().catch(() => undefined);
    }
  });
});
const mcpStatusStore = new McpStatusStore();
mcpStatusStore.configure(getConfig().agent.mcpServers);
function publishMcpStatusSnapshot(snapshot: McpStatusSnapshot): void {
  getSettingsWindow()?.webContents.send('mcp:status-snapshot', snapshot);
}
function resetMcpStatusSnapshot(): void {
  publishMcpStatusSnapshot(mcpStatusStore.reset());
}
// A runtime-generation boundary invalidates every live server status.
function notifyAgentRuntimeStopped(message: string): void {
  resetMcpStatusSnapshot();
  // One persistent failure card for unexpected loss; replacement,
  // disablement, and shutdown never reach this path.
  runtimeShell.showAgentFailed(activeAgentRunId, message);
}
const sidecarEventRouter = createSidecarEventRouter({
  getSettingsWindow,
  getActiveAgentRunId: () => activeAgentRunId,
  presenter: agentPresenter,
  openExternal: shell.openExternal,
  mergeDiscoveredTools,
  getConfig,
  recordMcpStatus: (status) => mcpStatusStore.record(status),
  onMemoryEvent: event => agentContext.handleMemoryEvent(event),
  onAgentTerminal: (agentRunId) => {
    if (activeAgentRunId === agentRunId) activeAgentRunId = null;
  },
});
const agentSidecar = new AgentSidecarManager(sidecarEventRouter.handle, {
  onLifecycleError: () => {
    notifyAgentRuntimeStopped('Agent runtime could not start securely. Check the logs and try again.');
  },
  onGenerationExit: () => {
    notifyAgentRuntimeStopped('Agent runtime stopped unexpectedly. Try Agent Mode again.');
    activeAgentRunId = null;
  },
});
const agentContext = registerAgentContextIpcHandlers(getPersistentStoreDirectory(), {
  getConfig,
  setAgent: agent => setConfig('agent', agent),
  getActiveAgentRunId: () => activeAgentRunId,
  reply: (agentRunId, requestId, result) => agentSidecar.sendMemoryResult(agentRunId, requestId, result),
  publish: snapshot => getSettingsWindow()?.webContents.send('memory:changed', snapshot),
});
const chatGptAuth = new ChatGptAuth({
  vault: credentialVault, fetch: (url, init) => fetch(url, init), now: Date.now,
  openBrowser: url => shell.openExternal(url), getHostId: getChatGptHostId, setHostId: setChatGptHostId,
  appIconDataUrl: () => loadAppIcon().toDataURL(),
  onChanged: status => {
    getSettingsWindow()?.webContents.send('chatgpt:changed', status);
    agentSidecar.cancelProviderTest();
    getSettingsWindow()?.webContents.send('agent:provider-invalidated');
    if (status.state === 'signed-out' && getConfig().agent.provider.kind === 'chatgpt') {
      if (getConfig().agent.enabled) agentSidecar.start(getConfig());
    }
  },
});
const recordingSession = new RecordingSession({
  runtimeShell,
  isAgentModeEnabled: () => cachedAgentEnabled,
  getRecordingActivationMode: (intent) => getConfig().shortcuts[intent].activationMode,
  onBegin: (intent) => {
    if (intent === 'agent') invalidateActiveAgentRun();
  },
  getShortcutBinding: (intent) => getConfig().shortcuts[intent].binding,
  getSelectedDeviceId: () => getConfig().selectedDeviceId,
  getDictationContext: () => {
    const config = getConfig();
    return {
      config: config.dictation,
      language: config.language,
      protectedTerms: config.dictionary,
      formatterApiKey: config.dictation.formatter?.processingConsent
        ? getDictationFormatterApiKey(config.dictation.formatter, credentialVault) : null,
    };
  },
  getRecognitionSettings: (intent) => {
    const config = getConfig();
    return resolveRecognitionSettings(intent === 'agent'
      ? { ...config, dictation: { ...config.dictation, mode: 'batch' } } : config);
  },
  getTranscriber: () => getTranscriber(getConfig(), credentialVault),
  captureTarget: () => waylandDelivery?.capture() ?? captureForegroundTarget(),
  getReadinessError: (intent) => {
    const config = getConfig();
    if (intent === 'agent') {
      const providerIssue = validateAgentProvider(config.agent.provider).issues[0];
      if (providerIssue) return new TranscriptionFailure('endpoint', `Agent Mode: ${providerIssue.message}`);
    }
    const errors = validateProviderReadiness(
      config.transcription.activeProvider,
      config,
      credentialVault,
    );
    return errors[0] ? new TranscriptionFailure('endpoint', errors[0]) : null;
  },
  onResult: routeRecordingResult,
  onError: showTranscriptionError,
});
runtimeShell.setCrashHandler((reason) => recordingSession.markRuntimeShellCrashed(reason));
const gotSingleInstanceLock = app.requestSingleInstanceLock();

async function routeRecordingResult(result: RecordingResult | null): Promise<void> {
  if (!result?.text || result.signal.aborted) return;

  if (result.outcome.kind === 'failed') {
    if (result.intent === 'dictation') {
      setLastTranscript(result.text, result.targetSnapshot);
      markLastTranscriptInjected('failed');
      runtimeShell.showFailure(result.recordingSessionId,
        'Transcription could not complete. Last Transcript contains the text recognized so far.',
        ['copy-full-transcript']);
    } else {
      showTranscriptionError(new TranscriptionFailure('unknown', 'Transcription could not complete. No Agent command was sent.'));
    }
    return;
  }

  if (result.intent === 'agent') {
    // Processing outranks every Agent card, so it must end before the run starts reporting.
    runtimeShell.finish();
    handleAgentTranscript(result.text);
    return;
  }

  const sessionId = result.recordingSessionId;
  const delivery = result.dictation;
  if (!delivery) return;
  let text = result.text;
  let formatterDegraded = false;

  if (
    delivery.config.mode === 'corrected'
    && delivery.config.formatter?.processingConsent
  ) {
    if (runtimeShell) runtimeShell.showProcessing(sessionId);
    const outcome = await applyDictationFormatter({
      profile: delivery.config.formatter,
      rawText: result.text,
      language: delivery.language,
      protectedTerms: delivery.protectedTerms,
      apiKey: delivery.formatterApiKey,
      signal: result.signal,
    });
    if (result.signal.aborted) return;
    if (outcome.kind === 'fallback') {
      text = outcome.rawText;
      formatterDegraded = true;
    } else {
      text = outcome.text;
    }
  }

  if (result.signal.aborted) return;

  setLastTranscript(text, result.targetSnapshot);

  const outcome = await deliverTranscript(text, result.targetSnapshot, result.signal, 'recording');
  if (!outcome) return;
  const { result: injectResult, actions } = outcome;
  if (result.signal.aborted) return;
  if (injectResult.kind === 'input-dispatched') {
    markLastTranscriptInjected('dispatched');
    completeOnboarding();
    if (formatterDegraded) showFormatterDegradedNotice();
    return;
  }

  markLastTranscriptInjected(result.targetSnapshot?.kind === 'kde-wayland' && injectResult.kind === 'error' ? 'uncertain' : 'failed');
  if (runtimeShell) {
    runtimeShell.showFailure(
      result.recordingSessionId,
      getRecoveryMessage(injectResult),
      actions,
    );
  } else {
    showRecoveryNotification(injectResult);
  }
}

function completeOnboarding(): void {
  if (getConfig().onboarding.status === 'complete') return;
  setConfig('onboarding', { status: 'complete' });
  setConfig('setupChecklistDismissed', true);
  getSettingsWindow()?.webContents.send('onboarding:completed');
}

function showFormatterDegradedNotice(): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'Corrected Dictation',
    body: 'Formatting was unavailable; your complete raw transcript was inserted.',
    silent: true,
  }).show();
}

async function pasteLastTranscript(): Promise<void> {
  const transcript = getLastTranscript();
  if (!transcript) return;

  const outcome = await deliverTranscript(transcript.text, null, new AbortController().signal, 'tray');
  if (!outcome) return;
  const { result } = outcome;
  if (result.kind !== 'input-dispatched') {
    showRecoveryNotification(result, 'Paste last transcript failed');
  }
}

async function deliverTranscript(
  text: string,
  target: import('../types/ipc').DictationTargetSnapshot | null,
  signal: AbortSignal,
  source: 'recording' | 'tray' | 'retry',
) {
  const copyOnly: import('../types/ipc').DictationRecoveryAction[] = ['copy-full-transcript'];
  const blocked = (reason: string) => ({
    result: { kind: 'input-blocked', acceptedEvents: 0, reason } satisfies InjectResult,
    actions: copyOnly,
  });
  // KDE delivery may have already sent input; replaying the recording could double-insert.
  if (source === 'retry' && (retryPasteInFlight || target?.kind === 'kde-wayland')) return null;
  const policyError = getAutomaticDeliveryError(process.platform, process.env, waylandDelivery?.isReady() ?? false);
  if (policyError) return blocked(policyError);
  if (source === 'tray') target = waylandDelivery?.capture() ?? null;
  if (source !== 'tray' && !target) {
    return blocked('The original destination could not be identified when recording began. Copy the transcript to the intended field.');
  }
  if (source === 'retry') retryPasteInFlight = true;
  try {
    if (target?.kind === 'kde-wayland') {
      if (!waylandDelivery) return blocked('Best-effort insertion is no longer set up. Nothing was pasted.');
      runtimeShell.finish();
      return { result: await waylandDelivery.deliver(text, target, signal), actions: copyOnly };
    }
    if (!await keyboardHook.waitForKeysReleased(signal)) {
      const result: InjectResult = { kind: 'input-blocked', acceptedEvents: 0,
        reason: 'Release the recording shortcut before pasting the transcript.' };
      return { result, actions: getRecoveryActions(result) };
    }
    if (signal.aborted) return null;
    runtimeShell.finish();
    const result = await injectIntoFocusedApp(text, target, signal);
    return { result, actions: getRecoveryActions(result) };
  } finally {
    if (source === 'retry') retryPasteInFlight = false;
  }
}

async function copyLastTranscript(): Promise<void> {
  const transcript = getLastTranscript();
  if (!transcript) return;
  await copyLastTranscriptToClipboard(transcript.text);
}

function showRecoveryNotification(result: InjectResult, title = 'Dictation Paste Failed'): void {
  let body: string;
  let detail = '';

  if (result.kind === 'clipboard-conflict') {
    body = 'Clipboard changed during dictation; use the tray to paste or copy the last transcript.';
  } else {
    detail = result.kind === 'error' ? `: ${result.message}`
      : result.kind === 'input-blocked' && result.reason ? `: ${result.reason}`
      : result.kind === 'target-changed' && result.reason ? `: ${result.reason}`
      : '';
    body = `Automatic paste failed${detail}. Use the tray to paste or copy the last transcript.`;
  }

  console.warn('Dictation recovery:', result.kind, detail);

  if (Notification.isSupported()) {
    new Notification({
      title,
      body,
      silent: true,
    }).show();
  }
}

function getRecoveryMessage(result: InjectResult): string {
  if (result.kind === 'clipboard-conflict') {
    return 'Clipboard changed during Dictation. Check the destination before copying the transcript; text may already have been inserted.';
  }
  if (result.kind === 'target-changed') return result.reason;
  if (result.kind === 'input-blocked') return result.reason ?? 'The system blocked automatic paste.';
  if (result.kind === 'error') return result.message;
  return 'Automatic paste failed.';
}

async function handleRuntimeRecoveryAction(action: import('../types/ipc').DictationRecoveryAction): Promise<void> {
  const transcript = getLastTranscript();
  if (!runtimeShell || !transcript) return;
  if (action === 'copy-full-transcript') {
    await copyLastTranscriptToClipboard(transcript.text);
    runtimeShell.finish();
    return;
  }
  if (action !== 'retry-paste') return;
  const outcome = await deliverTranscript(transcript.text, transcript.targetSnapshot, new AbortController().signal, 'retry');
  if (!outcome) return;
  const { result, actions } = outcome;
  if (result.kind === 'input-dispatched') {
    markLastTranscriptInjected('dispatched');
    return;
  }
  markLastTranscriptInjected('failed');
  runtimeShell.showFailure(null, getRecoveryMessage(result), actions);
}

// Never leave global shortcut activation suspended after capture ends.
setSettingsWindowClosedHandler(() => keyboardHook.setCaptureSuspended(false));

function setShortcutsPaused(paused: boolean): void {
  keyboardHook.setPaused(paused);
  updateShortcutPauseState(paused);
  const settingsWin = getSettingsWindow();
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('shortcuts:paused-changed', paused);
  }
}

function showTranscriptionError(err: unknown): void {
  const message = getSafeTranscriptionFailureMessage(err);
  console.error('Transcription failed:', {
    category: err instanceof TranscriptionFailure ? err.category : 'unknown',
    message,
  });
  runtimeShell.showFailure(null, message);
}

function handleAgentTranscript(text: string): void {
  void startAgentRun(text, getConfig());
}

function showAgentConfigNotice(message: string): void {
  runtimeShell.showAgentStatus(null, message);
}

function invalidateActiveAgentRun(): void {
  agentPresenter.beginRun();
  const previousRunId = activeAgentRunId;
  activeAgentRunId = null;
  if (!previousRunId) return;
  agentSidecar.cancelRun(previousRunId);
}

async function startAgentRun(text: string, config: AppConfig): Promise<void> {
  if (!config.agent.enabled) {
    console.warn('Ignoring Agent Mode transcript because Agent Mode is disabled');
    showAgentConfigNotice('Agent Mode is disabled. Open Settings to enable it.');
    return;
  }

  // A new run invalidates any prior run before replacement events can arrive.
  invalidateActiveAgentRun();
  const agentRunId = randomUUID();
  activeAgentRunId = agentRunId;
  let apiKey: string | undefined;
  try {
    apiKey = config.agent.provider.kind === 'chatgpt'
      ? await chatGptAuth.getAccessToken() : getAgentSidecarApiKey(config, credentialVault);
  } catch (error) {
    if (activeAgentRunId !== agentRunId) return;
    activeAgentRunId = null;
    runtimeShell.showFailure(null, error instanceof Error ? error.message : 'Sign in with ChatGPT again in Settings.');
    return;
  }
  if (activeAgentRunId !== agentRunId) return;
  if (!getConfig().agent.enabled) { activeAgentRunId = null; return; }
  agentSidecar.startRun(
    agentRunId,
    text,
    config,
    apiKey,
    agentContext.createRunContext(),
  );
  console.log(`Started Agent Mode run ${agentRunId}`);
  getSettingsWindow()?.webContents.send('audit:run-updated', agentRunId);
}

function publishUpdateStatus(status: UpdateStatus): void {
  updateUpdaterStatus(status);
  const settingsWin = getSettingsWindow();
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('updater:status-changed', status);
  }
}

async function showBundledReleaseNotesAfterInstall(): Promise<void> {
  const releaseNotes = getBundledReleaseNotes();
  if (
    !releaseNotes ||
    getLastSeenReleaseNotesVersion() === releaseNotes.version
  ) {
    return;
  }

  try {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: "What's New",
      message: `Shuddhalekhan v${releaseNotes.version} is installed.`,
      detail: getReleaseNotesPreview([releaseNotes]),
      buttons: ["View What's New", 'Close'],
      defaultId: 0,
      cancelId: 1,
    });
    setLastSeenReleaseNotesVersion(releaseNotes.version);
    if (response === 0) {
      openSettingsWindow('about');
    }
  } catch {
    // A failed informational dialog must not prevent app startup.
  }
}

// IPC handlers
function invalidateProviderTest(): void {
  providerTestRevision++;
  agentSidecar.cancelProviderTest();
  getSettingsWindow()?.webContents.send('agent:provider-invalidated');
}

function validateAgentProvider(provider: AgentProviderConfig) {
  const normalized = normalizeAgentProvider(provider);
  if (normalized.kind === 'chatgpt') {
    const status = chatGptAuth.getStatus();
    // Validation reads account state without minting or exposing a credential.
    return resolveAgentProviderKey(provider, status.state === 'signed-in' && status.planUsage ? 'available' : undefined, {}).validation;
  }
  const apiKey = normalized.auth !== 'none' && normalized.apiKeySource === 'stored'
    ? credentialVault.read('agent-api-key') ?? undefined : undefined;
  return resolveAgentProviderKey(provider, apiKey, process.env).validation;
}

registerCredentialIpcHandlers(ipcMain, credentialVault, credential => {
  getSettingsWindow()?.webContents.send('credential:changed', credential);
  if (credential === 'agent-api-key') invalidateProviderTest();
});

ipcMain.handle('chatgpt:get-status', () => chatGptAuth.getStatus());
ipcMain.handle('chatgpt:sign-in', () => chatGptAuth.signIn());
ipcMain.handle('chatgpt:sign-out', () => {
  providerTestRevision++;
  if (getConfig().agent.provider.kind === 'chatgpt') invalidateActiveAgentRun();
  return chatGptAuth.signOut();
});
ipcMain.handle('chatgpt:list-models', () => chatGptAuth.listModels());

ipcMain.handle('agent:validate-provider', (_event, value: unknown) => {
  const parsed = agentProviderSchema.safeParse(value);
  if (!parsed.success) return { issues: [{ field: 'kind', message: 'Provider settings contain an invalid value.' }], credentials: 'missing' };
  return validateAgentProvider(parsed.data);
});

ipcMain.handle('agent:test-provider', async (_event, value: unknown) => {
  const parsed = agentProviderSchema.safeParse(value);
  if (!parsed.success) return failedProviderTest({ kind: 'configuration', message: 'Provider settings contain an invalid value.', action: 'Correct the Agent settings.' });
  const provider = normalizeAgentProvider(parsed.data);
  const validation = validateAgentProvider(provider);
  if (validation.issues.length) return failedProviderTest({ kind: 'configuration', message: validation.issues[0].message, action: 'Correct the Agent settings before testing.' }, validation);
  if (!getConfig().agent.enabled) return failedProviderTest({ kind: 'configuration', message: 'Agent Mode is disabled.', action: 'Enable Agent Mode to test the model. Local validation works while disabled.' }, validation);
  if (activeAgentRunId) return failedProviderTest({ kind: 'busy', message: 'An agent run is active.', action: 'Wait for the run to finish before testing the model.' }, validation);
  const revision = ++providerTestRevision;
  let apiKey: string | undefined;
  try {
    apiKey = provider.kind === 'chatgpt' ? await chatGptAuth.getAccessToken()
      : provider.apiKeySource === 'stored' && provider.auth !== 'none' ? credentialVault.read('agent-api-key') ?? undefined : undefined;
  } catch (error) {
    return failedProviderTest({ kind: 'authentication', message: error instanceof Error ? error.message : 'Sign in with ChatGPT again.', action: 'Open ChatGPT account settings and sign in again.' }, validateAgentProvider(provider));
  }
  if (revision !== providerTestRevision || activeAgentRunId || !getConfig().agent.enabled) {
    return failedProviderTest({ kind: 'cancelled', message: 'The provider test was cancelled.', action: 'Test the current provider again when ready.' }, validation);
  }
  return agentSidecar.testProvider(provider, apiKey);
});

ipcMain.handle('agent:cancel-provider-test', () => { providerTestRevision++; agentSidecar.cancelProviderTest(); });

ipcMain.handle('audio:get-devices', async () => {
  const webContents = recordingSession.getAudioWebContents();
  if (!webContents) return [];
  // Devices will be enumerated by the renderer and sent back via a different IPC
  // For now, return empty and let the tray update happen from the renderer
  return [];
});

ipcMain.handle('audio:select-device', (_event, deviceId: string) => {
  setConfig('selectedDeviceId', deviceId);
  recordingSession.updateDevice(deviceId);
});

ipcMain.handle('config:get', () => {
  return getConfig();
});
ipcMain.handle('desktop:get-status', getDesktopStatus);
ipcMain.handle('desktop:set-wayland-insertion', async (_event, enabled: unknown) => {
  await setWaylandInsertion(enabled === true);
  return getDesktopStatus();
});

ipcMain.handle('shortcuts:get-paused', () => {
  return keyboardHook.isPaused();
});

ipcMain.handle('shortcuts:set-paused', (_event, paused: boolean) => {
  setShortcutsPaused(Boolean(paused));
  return keyboardHook.isPaused();
});

ipcMain.handle('shortcuts:begin-capture', () => {
  keyboardHook.setCaptureSuspended(true);
});

ipcMain.handle('shortcuts:end-capture', () => {
  keyboardHook.setCaptureSuspended(false);
});

ipcMain.handle('transcription:check-server', async () => {
  const config = getConfig();
  const provider = config.transcription.activeProvider;

  if (provider === 'local-whisper-cpp') {
    return checkServerReachability(config.transcription.providers.localWhisperCpp.endpoint);
  }

  // OpenAI Cloud: local-only, zero fetches
  if (provider === 'openai') {
    return false;
  }

  if (provider === 'nvidia-speech-nim') {
    const { endpoint, auth } = config.transcription.providers.nvidiaSpeechNim;
    if (auth !== 'none') return false;
    return checkServerReachability(endpoint);
  }

  // Custom with auth: local-only, zero fetches
  if (provider === 'custom-open-ai-compatible') {
    const { endpoint, auth } = config.transcription.providers.customOpenAiCompatible;
    if (auth !== 'none') return false;
    return checkServerReachability(endpoint);
  }

  return false;
});

ipcMain.handle('transcription:check-readiness', async () => {
  const config = getConfig();
  const provider = config.transcription.activeProvider;
  if (provider === 'managed-local') {
    const state = await getManagedLocalModelManager().getState();
    if (state.kind === 'ready') {
      try {
        await managedLocalTranscriber.warmup();
        const snapshot = await managedLocalSnapshot();
        return { providerId: provider, state: 'ready' as const,
          message: snapshot.runtime.status === 'ready'
            ? snapshot.runtime.message || `Running on ${snapshot.runtime.backend === 'cuda' ? 'NVIDIA GPU' : 'CPU'}.` :'Model files are installed. Changes apply to the next recording.',
          checkedAt: new Date().toISOString() };
      } catch (error) {
        return { providerId: provider, state: 'unavailable' as const,
          message: getSafeTranscriptionFailureMessage(error), checkedAt: new Date().toISOString() };
      }
    }
    return {
      providerId: provider,
      state: 'unavailable' as const,
      message: state.kind === 'error'
          ? state.message
          : 'Install the recommended local speech model to start Dictation.',
      checkedAt: new Date().toISOString(),
    };
  }
  if (provider !== 'whisper-live-kit') {
    const error = validateProviderReadiness(provider, config, credentialVault)[0];
    return {
      providerId: provider,
      state: error ? 'unavailable' as const : 'ready' as const,
      message: error ?? 'Settings are complete. Provider connectivity has not been checked.',
      checkedAt: new Date().toISOString(),
    };
  }

  const checking = {
    providerId: provider,
    state: 'checking' as const,
    message: 'Checking WhisperLiveKit health and PCM WebSocket readiness...',
    checkedAt: null,
  };
  getSettingsWindow()?.webContents.send('transcription:readiness-changed', checking);

  const providerConfig = config.transcription.providers.whisperLiveKit;
  const readiness = await checkWhisperLiveKitReadiness(
    providerConfig ?? { baseUrl: '', auth: 'none' },
    providerConfig?.auth === 'bearer' ? credentialVault.read('whisper-live-kit-bearer') : null,
  );
  getSettingsWindow()?.webContents.send('transcription:readiness-changed', readiness);
  return readiness;
});

ipcMain.handle('managed-local:get-model', managedLocalSnapshot);
ipcMain.handle('managed-local:install-model', (_event, target: unknown) => installManagedLocalModel(target));
ipcMain.handle('managed-local:delete-model', (_event, target: unknown) => {
  if (recordingSession.isBusy()) throw new Error('Finish the current recording before deleting local model files.');
  return deleteManagedLocalModel(target);
});

ipcMain.handle('config:patch-transcription', async (_event, patch: unknown) => {
  const previous = getConfig();
  const config = patchTranscriptionConfig(patch);
  if (previous.transcription.activeProvider === 'managed-local' && config.transcription.activeProvider !== 'managed-local') {
    await managedLocalTranscriber.shutdown().catch(() => undefined);
  }
  return config;
});

ipcMain.handle('config:set', async (_event, key: keyof AppConfig, value: AppConfig[keyof AppConfig]) => {
  const previousConfig = getConfig();
  setConfig(key, value);
  const config = getConfig();
  if (key === 'agent') {
    if (previousConfig.agent.memoryEnabled !== config.agent.memoryEnabled || previousConfig.agent.enabled !== config.agent.enabled) agentContext.invalidateMemory();
    invalidateProviderTest();
    publishMcpStatusSnapshot(mcpStatusStore.configure(config.agent.mcpServers));
  }
  cachedAgentEnabled = config.agent.enabled;
  if (key === 'shortcuts' || key === 'agent') keyboardHook.refreshShortcuts();
  // A switched-away provider has no next use with this runtime; release
  // the loaded model instead of holding ~1.1GB idling all session.
  if (
    previousConfig.transcription.activeProvider === 'managed-local' &&
    config.transcription.activeProvider !== 'managed-local'
  ) {
    await managedLocalTranscriber.shutdown().catch(() => undefined);
  }
  const sidecarAction = getSidecarConfigAction(previousConfig, config);
  if (sidecarAction === 'stop') {
    await agentSidecar.stop();
    resetMcpStatusSnapshot();
  } else if (sidecarAction === 'start') {
    agentSidecar.start(config, getAgentSidecarApiKey(config, credentialVault));
  }
});

ipcMain.handle('mcp:test-server', async (_event, serverId: string) => {
  const config = getConfig();
  const server = config.agent.mcpServers.find((item) => item.id === serverId);
  if (!config.agent.enabled || !server?.enabled) return;

  agentSidecar.testMcpServer(config, getAgentSidecarApiKey(config, credentialVault), serverId);
});

ipcMain.handle('mcp:get-status-snapshot', () => mcpStatusStore.getSnapshot());

ipcMain.handle('settings:open', () => {
  openSettingsWindow();
});

ipcMain.handle(
  'agent:approval-decision',
  (_event, agentRunId: string, approvalId: string, decision: AgentApprovalChoice, message?: string) => {
    // The renderer is untrusted input: anything unrecognized must never approve.
    if (decision !== 'approved' && decision !== 'denied' && decision !== 'always-allow') {
      throw new Error('Invalid approval decision');
    }
    const approval = decision === 'always-allow' ? runtimeShell.getPendingApproval(approvalId) : null;
    if (approval) {
      const config = getConfig();
      const policyKey: McpToolPolicyKey = makeMcpToolPolicyKey(approval.serverId, approval.toolName);
      setConfig('agent', {
        ...config.agent,
        mcpServers: config.agent.mcpServers.map((server) => server.id === approval.serverId
          ? { ...server, toolPolicies: { ...server.toolPolicies, [policyKey]: 'alwaysAllow' } }
          : server),
      });
      // Later calls in this same run should see the new policy too.
      const next = getConfig();
      agentSidecar.start(next, getAgentSidecarApiKey(next, credentialVault));
    }
    agentSidecar.sendApprovalDecision(agentRunId, approvalId, decision === 'denied' ? 'denied' : 'approved', message);
  }
);

ipcMain.handle('app:get-info', async () => {
  return {
    name: app.name,
    version: app.getVersion(),
    isPackaged: app.isPackaged,
  };
});

ipcMain.handle('app:get-release-notes', () => {
  return getBundledReleaseNotes();
});

ipcMain.handle('updater:get-status', () => {
  return getUpdateStatus();
});

ipcMain.handle('updater:check', async () => {
  return checkForUpdates();
});

ipcMain.handle('audit:get-runs', async () => {
  return getAuditRuns();
});

ipcMain.handle('audit:get-run-detail', async (_event, agentRunId: string) => {
  return getAuditRunDetail(agentRunId);
});

// Renderer -> Main events
ipcMain.on('audio-devices', (_event, devices: AudioDevice[]) => {
  updateAudioDevices(devices);
});

ipcMain.on('runtime:recovery-action', (_event, action) => {
  void handleRuntimeRecoveryAction(action).catch((err) => {
    console.error('Failed to handle runtime recovery action:', err);
  });
});

ipcMain.on('runtime:agent-card-size', (_event, height: number) => {
  runtimeShell?.handleAgentCardSize(height);
});

ipcMain.on('runtime:agent-dismiss', () => {
  runtimeShell?.dismissAgentCard();
});

ipcMain.on('surface-paint-proxy', (_event, surface: string) => {
  if (surface === 'recording') runtimeReadiness.markShellPaintReady();
});

// App lifecycle
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    if (process.platform === 'linux' && !app.isPackaged) {
      try {
        const cleanup = prepareDevelopmentIdentity({ executable: process.execPath, appPath: app.getAppPath() });
        app.on('will-quit', cleanup);
      } catch (error) {
        console.warn('Could not prepare the development desktop identity:', error);
      }
    }
    keyboardHook.setLinuxShortcutStatusListener(status => {
      desktopShortcuts = status;
      publishDesktopStatus();
      if (status.backend === 'unavailable') {
        void dialog.showMessageBox({
          type: 'warning', title: 'Shortcuts unavailable',
          message: 'Shuddhalekhan could not register its keyboard shortcuts.', detail: status.error,
        });
      }
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'media');
    });
    configureManagedLocal({
      root: join(preparePersistentStoreDirectory(), 'models'),
      onStateChanged: (state) => {
        getSettingsWindow()?.webContents.send('managed-local:model-state-changed', state);
      },
    });

    try {
      recordingSession.start();
    } catch (error) {
      void dialog.showMessageBox({
        type: 'warning',
        title: 'Shortcuts unavailable',
        message: 'Shuddhalekhan could not listen for its keyboard shortcuts.',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const failClosed = () => { void recordingSession.cancel(); };
    powerMonitor.on('suspend', failClosed);
    powerMonitor.on('lock-screen', failClosed);

    createTray({
      onOpenSettings: () => openSettingsWindow(),
      onPasteLastTranscript: () => pasteLastTranscript(),
      onCopyLastTranscript: () => copyLastTranscript(),
      onCheckForUpdates: () => void checkForUpdates(),
      isShortcutsPaused: () => keyboardHook.isPaused(),
      onTogglePause: (paused: boolean) => setShortcutsPaused(paused),
      onSelectDevice: (deviceId: string) => {
        setConfig('selectedDeviceId', deviceId);
        recordingSession.updateDevice(deviceId);
      },
    });

    const startupConfig = getConfig();
    cachedAgentEnabled = startupConfig.agent.enabled;
    if (startupConfig.agent.enabled) {
      resetMcpStatusSnapshot();
      agentSidecar.start(
        startupConfig,
        getAgentSidecarApiKey(startupConfig, credentialVault),
      );
    }
    if (startupConfig.onboarding.status === 'pending') openSettingsWindow();
    // The user opted in earlier; reconnect at launch (never after recognition).
    if (startupConfig.waylandBestEffortInsertion) void setWaylandInsertion(true);

    setupUpdater(publishUpdateStatus, () => openSettingsWindow('about'));
    publishUpdateStatus(getUpdateStatus());
    void showBundledReleaseNotesAfterInstall();
    runtimeReadiness.markMainReady();

    app.on('activate', () => {
      // Keep running in tray; no main window to recreate
    });
  });

  app.on('window-all-closed', () => {
    // Keep running in tray on Windows
  });

  let quitCleanupStarted = false;
  let quitCleanupComplete = false;
  app.on('before-quit', (event) => {
    if (quitCleanupComplete) return;
    event.preventDefault();
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;
    agentContext.invalidateMemory();
    void recordingSession.cancel();
    recordingSession.stop();
    void Promise.all([agentSidecar.stop(), managedLocalTranscriber.shutdown(), waylandDelivery?.disable()]).finally(() => {
      resetMcpStatusSnapshot();
      closeDb();
      quitCleanupComplete = true;
      // Cleanup often settles as a microtask inside this same before-quit
      // dispatch; a re-entrant app.quit() there hangs Electron (seen on SIGTERM).
      setImmediate(() => app.quit());
    });
  });
}
