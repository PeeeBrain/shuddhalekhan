import { useContext, useEffect, useEffectEvent, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { AccessibilityInfo, ActivityIndicator, Alert, Animated, Easing, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Host, Picker, Text as SwiftText } from '@expo/ui/swift-ui';
import { disabled, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { isParakeetLanguage, languageLabel } from '../languages';
import { recordingLimitSeconds, transcriptionReady } from '../providers';
import type { useMobileApp } from '../useMobileApp';
import type { AgentStep } from '@shuddhalekhan/shared/agent-loop';
import { Button, Card, ReducedMotionContext, color, styles as kit, type } from './kit';
import { Markdown } from './Markdown';
import { useDictation } from './useDictation';
import type { SettingsPage } from './SettingsScreen';

type App = ReturnType<typeof useMobileApp>;
type Intent = App['intent'];

const busyLabel: Partial<Record<App['phase'], string>> = {
  loading: 'Loading settings…',
  requestingPermission: 'Waiting for microphone permission…',
  transcribing: 'Transcribing…',
  running: 'Agent is working…',
  awaitingApproval: 'Waiting for your approval…',
};
// Statuses that only restate "nothing is happening" stay off screen.
const restStatus = new Set(['Ready to record.', 'Done.']);

export function HomeScreen({ app, onOpenSettings, onReviewApproval }: { app: App; onOpenSettings: (page?: SettingsPage) => void; onReviewApproval: () => void }) {
  const { settings, phase, transcript, response, status, error } = app;
  const [picked, setPicked] = useState<Intent>('dictation');
  const idle = phase === 'idle';
  // While a run is in flight the hook's intent is the truth; the picker only matters at rest.
  const intent: Intent = idle ? (settings.agentEnabled ? picked : 'dictation') : app.intent;
  const onDevice = settings.transcriptionSource === 'on-device';
  const configured = onDevice ? app.localModel.kind === 'ready' : transcriptionReady(settings);
  const canRetry = idle && settings.agentEnabled && transcript.trim() !== '';
  const setupCard = idle && !configured && !app.keyboardSession.active;
  const line = (status && !restStatus.has(status) ? status : '') || busyLabel[phase] || '';
  // iOS ignores accessibilityLiveRegion, so VoiceOver hears changes only when announced. One announcement per
  // change (an error wins), and none for what was already on screen when Home mounted.
  // "Done." stays off screen but is still spoken, so a finished run is never silent. Nothing is spoken while
  // recording: the microphone would hear it, and the Stop button already says what is happening.
  const spoken = phase === 'recording' ? '' : error || line || (status === 'Done.' ? status : '');
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current && spoken) AccessibilityInfo.announceForAccessibility(spoken);
    mounted.current = true;
  }, [spoken]);

  return (
    <SafeAreaView style={home.screen}>
      <View style={home.header}>
        <Text style={[type.largeTitle, { flexShrink: 1 }]} accessibilityRole="header">Shuddhalekhan</Text>
        <Button label="Settings" systemImage="gearshape" iconOnly kind="ghost" onPress={() => onOpenSettings()} disabled={!idle} />
      </View>

      <ScrollView contentContainerStyle={home.content} contentInsetAdjustmentBehavior="automatic">
        {error ? (
          <Card>
            <Text style={[type.body, { color: color.red }]} selectable accessibilityRole="alert">{error}</Text>
            {phase !== 'loading' ? <Button label="Dismiss" kind="ghost" small onPress={app.dismissError} /> : (
              <Button label="Reset Saved Settings" kind="destructive" small onPress={() => Alert.alert(
                'Reset saved settings?',
                'This removes your saved provider settings, API keys, and MCP configuration. You will need to enter them again.',
                [{ text: 'Cancel', style: 'cancel' }, { text: 'Reset Settings', style: 'destructive', onPress: () => { void app.resetSettings(); } }],
              )} />
            )}
          </Card>
        ) : null}

        {app.activityNotice ? <Text style={type.footnote} accessibilityLiveRegion="polite">{app.activityNotice}</Text> : null}

        {app.approval ? (
          <Card agent>
            <Text style={type.headline}>{app.approval.toolName}</Text>
            <Text style={type.footnote}>Tool approval needed · {app.approval.serverName}</Text>
            <Button label="Review Request" kind="agent" wide onPress={onReviewApproval} />
          </Card>
        ) : null}

        {setupCard ? (
          <Card>
            <Text style={type.headline}>{onDevice ? 'Download a speech model' : 'Set up transcription'}</Text>
            <Text style={type.footnote}>{onDevice ? localModelHint(app.localModel) : "Add your provider's key or endpoint. Use your computer's LAN address, not localhost."}</Text>
            <Button label="Open Settings" kind="primary" wide onPress={() => onOpenSettings('transcription')} />
          </Card>
        ) : null}

        <View style={home.hero}>
          {settings.agentEnabled ? (
            <Host matchContents={{ vertical: true }} colorScheme="dark" style={home.modes}>
              <Picker selection={intent} onSelectionChange={v => setPicked(v === 'agent' ? 'agent' : 'dictation')} modifiers={[pickerStyle('segmented'), disabled(!idle)]}>
                <SwiftText modifiers={[tag('dictation')]}>Dictation</SwiftText>
                <SwiftText modifiers={[tag('agent')]}>Agent</SwiftText>
              </Picker>
            </Host>
          ) : null}
          <RecordControl app={app} intent={intent} configured={configured} />
          <Text style={[type.footnote, home.status]} accessibilityLiveRegion="polite" selectable>{line}</Text>
        </View>

        {/* One slot for both states, so starting a session doesn't remount the card mid-layout. */}
        <KeyboardSession app={app} onSetUp={() => onOpenSettings('keyboard')} />

        {app.intent === 'agent' && (transcript || response || app.turns.length > 0) ? (
          <Card agent>
            <Text style={[type.caption, { color: color.vermilion }]} accessibilityRole="header">Agent</Text>
            {app.turns.map((turn, index) => (
              <View key={index} style={home.turn}>
                <Bubble text={turn.command} />
                <Markdown>{turn.response}</Markdown>
              </View>
            ))}
            {transcript ? <Bubble text={transcript} /> : null}
            {response ? <Steps steps={app.steps} /> : null}
            {response ? <Markdown>{response}</Markdown> : null}
            <View style={kit.buttons}>
              <CopyShare text={response || transcript} />
              {canRetry && !response ? <Button label="Send Again" systemImage="paperplane" small kind="agent" onPress={app.retryAgent} /> : null}
            </View>
            {app.canReply ? <Text style={type.caption}>Record an Agent command to reply. Clear starts fresh.</Text> : null}
          </Card>
        ) : transcript ? (
          <Card>
            <Text style={type.caption} accessibilityRole="header">Transcript</Text>
            <Text style={type.body} selectable>{transcript}</Text>
            <View style={kit.buttons}>
              <CopyShare text={transcript} />
              {canRetry ? <Button label="Send to Agent" systemImage="paperplane" small kind="agent" onPress={app.retryAgent} /> : null}
            </View>
          </Card>
        ) : null}

        {idle && (transcript || response || app.turns.length > 0) ? <View style={home.clear}><Button label="Clear" kind="ghost" onPress={app.clearResults} /></View> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const easeOut = Easing.out(Easing.exp);

/**
 * One control through idle, recording, and busy, so state changes animate instead of remounting.
 * Motion is transform and opacity only, on the native driver. While recording, a halo in the mode's
 * shape follows the microphone level; under Reduce Motion it holds still.
 */
function RecordControl({ app, intent, configured }: { app: App; intent: Intent; configured: boolean }) {
  const reduceMotion = useContext(ReducedMotionContext);
  const { phase } = app;
  const agent = intent === 'agent';
  const tint = agent ? color.vermilion : color.blue;
  const shape = { borderRadius: agent ? 16 : 56 };
  const recording = phase === 'recording';
  const busy = !recording && phase !== 'idle' && phase !== 'loading';
  const mode = recording ? 'recording' : busy ? 'busy' : 'idle';

  const [press] = useState(() => new Animated.Value(1));
  const [settle] = useState(() => new Animated.Value(1));
  const [level] = useState(() => new Animated.Value(0));
  // Built once: the timer re-renders this every second, and fresh nodes would re-attach the native animation.
  const [scale] = useState(() => Animated.multiply(press, settle));
  const [halo] = useState(() => ({
    opacity: level.interpolate({ inputRange: [0, 1], outputRange: [0.14, 0.26] }),
    transform: [{ scale: level.interpolate({ inputRange: [0, 1], outputRange: [1, 1.26] }) }],
  }));
  const pressedWhileRecording = useRef<boolean | null>(null);
  const pressTo = (toValue: number) => {
    if (!reduceMotion) Animated.spring(press, { toValue, speed: toValue < 1 ? 50 : 24, bounciness: 0, useNativeDriver: true }).start();
  };

  // Each state change lands as a short settle from slightly smaller, so the control visibly answers.
  const shown = useRef(mode);
  useEffect(() => {
    if (shown.current === mode) return;
    shown.current = mode;
    if (reduceMotion) return;
    settle.setValue(0.9);
    Animated.timing(settle, { toValue: 1, duration: 240, easing: easeOut, useNativeDriver: true }).start();
  }, [mode, reduceMotion, settle]);

  // About 11 readings a second, only while recording; each one eases the halo toward the new level.
  // Under Reduce Motion the halo holds still at rest, so nothing is polled.
  const readLevel = useEffectEvent(app.inputLevel);
  useEffect(() => {
    level.setValue(0);
    if (!recording || reduceMotion) return;
    const timer = setInterval(() => {
      Animated.timing(level, { toValue: readLevel(), duration: 90, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    }, 90);
    return () => clearInterval(timer);
  }, [recording, reduceMotion, level]);

  // A keyboard session gives up the microphone to a tap here, but not mid-utterance.
  const off = !recording && (phase !== 'idle' || !configured || app.keyboardSession.busy || app.keyboardSession.starting);
  const limit = recordingLimitSeconds(app.settings);
  const m = Math.floor(app.elapsedSeconds / 60);
  const s = String(app.elapsedSeconds % 60).padStart(2, '0');
  // Ochre marks the approaching time limit, as on the desktop pill; recording stops on its own at zero.
  const left = limit - app.elapsedSeconds;
  const ending = left <= 10;

  return (
    <>
      <View style={home.record}>
        {recording ? <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, shape, { backgroundColor: tint }, halo]} /> : null}
        <Animated.View style={{ transform: [{ scale }] }}>
          <Pressable
            // A press acts as what it was when the finger landed: holding Stop through an auto-stop must not start a recording.
            onPress={() => {
              const landed = pressedWhileRecording.current;
              pressedWhileRecording.current = null;
              if (landed !== null && landed !== recording) return;
              void (recording ? app.stopRecording() : app.startRecording(intent));
            }}
            // Touch start, not press-in: press-in fires again when a held finger slides back over the button.
            onTouchStart={() => { pressedWhileRecording.current = recording; }}
            onPressIn={() => pressTo(0.94)}
            onPressOut={() => pressTo(1)}
            disabled={off}
            accessibilityRole="button"
            accessibilityLabel={recording ? (agent ? 'Stop and send to agent' : 'Stop and transcribe')
              : busy ? busyLabel[phase] : agent ? 'Record agent command' : 'Start dictation'}
            accessibilityHint={recording || busy ? undefined
              : `Records up to ${limit % 60 === 0 ? `${limit / 60} minutes` : `${limit} seconds`}${app.keyboardSession.active ? ' and ends the keyboard session' : ''}`}
            accessibilityState={{ disabled: off, busy }}
            style={({ pressed }) => [home.button, shape, recording ? { backgroundColor: tint } : [home.buttonIdle, { borderColor: tint }],
              pressed && (recording ? { opacity: 0.8 } : { backgroundColor: color.raised }), off && !busy && { opacity: 0.4 }]}
          >
            {recording ? <View style={home.stopGlyph} />
              : busy ? <ActivityIndicator color={tint} size="large" />
                : <View style={[home.micGlyph, { backgroundColor: tint, borderRadius: agent ? 4 : 17 }]} />}
          </Pressable>
        </Animated.View>
      </View>
      {recording ? (
        <Text style={[type.title, home.timer, { color: ending ? color.ochre : tint }]} accessibilityLabel={`Recording, ${m} minutes ${s} seconds`}>
          {ending ? `Stops in ${Math.max(0, left)} s` : `${m}:${s}`}
        </Text>
      ) : null}
      {recording || busy ? <Button label="Cancel" kind="ghost" onPress={app.cancel} /> : null}
    </>
  );
}

// Native owns the session; this only starts, shows, and stops it. The countdown keeps the open mic obvious.
function KeyboardSession({ app, onSetUp }: { app: App; onSetUp: () => void }) {
  const session = app.keyboardSession;
  const minutes = useDictation().preferences?.sessionMinutes ?? 10;
  if (!session.available) return null;
  if (session.active) {
    const m = Math.floor(session.remainingSeconds / 60);
    const s = String(session.remainingSeconds % 60).padStart(2, '0');
    return (
      <Card>
        <View style={home.sessionRow}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={type.headline} accessibilityRole="header">Keyboard session on</Text>
            <Text style={type.footnote}>
              {session.remainingSeconds === 0 && session.busy ? 'Finishing this utterance…' : 'Switch back and use the keyboard. Only audio between Dictate and Stop is kept. Recording here ends the session.'}
            </Text>
          </View>
          <Text style={[type.title, home.timer, { color: session.remainingSeconds <= 60 ? color.ochre : color.blue }]} accessibilityLabel={`${m} minutes ${s} seconds left`}>
            {m}:{s}
          </Text>
          <Button label="Stop" kind="destructive" small onPress={() => { void app.stopKeyboardSession(); }} />
        </View>
      </Card>
    );
  }
  const supported = isParakeetLanguage(app.settings.language);
  const ready = supported && app.localModel.kind === 'ready';
  const detail = session.endedReason ? `Last session ended: ${session.endedReason}`
    : app.preparingModel ? 'Preparing speech recognition…'
      : ready ? `Use the Shuddhalekhan keyboard in any app for ${minutes} minutes.`
        : supported ? 'Needs the on-device Parakeet model.'
          : `Parakeet doesn't support ${languageLabel(app.settings.language)}.`;
  return (
    <Card>
      <View style={home.sessionRow}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={type.headline} accessibilityRole="header">Keyboard</Text>
          <Text style={[type.footnote, session.endedReason ? { color: color.red } : null]}>{detail}</Text>
        </View>
        {ready ? (
          <Button
            label={session.starting ? 'Starting…' : 'Start'}
            kind="primary"
            small
            disabled={session.starting || app.phase !== 'idle'}
            onPress={() => {
              app.startKeyboardSession().catch((e: unknown) => Alert.alert('Keyboard session', e instanceof Error ? e.message : 'Could not start the session.'));
            }}
          />
        ) : null}
        <Button label="Set Up" kind={ready ? 'ghost' : 'secondary'} small onPress={onSetUp} disabled={app.phase !== 'idle'} />
      </View>
    </Card>
  );
}

function localModelHint(model: App['localModel']): string {
  switch (model.kind) {
    case 'checking': return 'Checking the installed on-device model…';
    case 'ready': return '';
    case 'downloading': return `Downloading (${Math.round(model.fraction * 100)}%). You can record once it's ready.`;
    case 'installing': return 'Preparing the model for this iPhone. The first time can take a few minutes.';
    case 'unavailable': return 'Install the updated app to use on-device Parakeet, or switch to an endpoint.';
    case 'error': return "The model couldn't be installed. Retry in Settings.";
    case 'missing': return 'Download Parakeet for your language (about 0.5 GB) to record on this iPhone.';
  }
}

/** A spoken Agent command, shown as the user's side of the conversation. */
function Bubble({ text }: { text: string }) {
  return (
    <View style={home.bubble} accessibilityLabel={`You said: ${text}`}>
      <Text style={type.body} selectable>{text}</Text>
    </View>
  );
}

/** What the agent said and which tools it called on the way to the answer, folded until tapped. */
function Steps({ steps }: { steps: AgentStep[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const tools = [...new Set(steps.flatMap(step => step.tools))];
  return (
    <View style={home.steps}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}>
        <Text style={type.caption}>
          {open ? '▾' : '▸'} {steps.length === 1 ? '1 step' : `${steps.length} steps`}{tools.length > 0 ? ` · ${tools.join(', ')}` : ''}
        </Text>
      </Pressable>
      {open ? steps.map((step, index) => (
        <View key={index} style={home.step}>
          {step.text.trim() ? <Text style={type.footnote} selectable>{step.text.trim()}</Text> : null}
          {step.tools.map((tool, toolIndex) => <Text key={toolIndex} style={type.footnote}>🔧 {tool}</Text>)}
        </View>
      )) : null}
    </View>
  );
}

function CopyShare({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button
        label={copied ? 'Copied' : 'Copy'}
        systemImage={copied ? 'checkmark' : 'doc.on.doc'}
        small
        onPress={() => {
          Clipboard.setStringAsync(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }, () => Alert.alert('Could not copy', 'Try selecting the text and copying it.'));
        }}
      />
      <Button label="Share" systemImage="square.and.arrow.up" small onPress={() => {
        void Share.share({ message: text }).catch(() => Alert.alert('Could not share', 'Try copying the text instead.'));
      }} />
    </>
  );
}

const home = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.page },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  content: { padding: 20, gap: 16, paddingBottom: 48 },
  hero: { alignItems: 'center', gap: 16, paddingVertical: 12 },
  modes: { alignSelf: 'stretch' },
  record: { width: 112, height: 112 },
  button: { width: 112, height: 112, alignItems: 'center', justifyContent: 'center' },
  buttonIdle: { borderWidth: 2, backgroundColor: color.card },
  micGlyph: { width: 34, height: 34 },
  stopGlyph: { width: 32, height: 32, borderRadius: 5, backgroundColor: color.onSignal },
  timer: { fontVariant: ['tabular-nums'] },
  status: { textAlign: 'center', minHeight: 18 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  clear: { alignItems: 'center' },
  turn: { gap: 8, opacity: 0.75 },
  steps: { gap: 6 },
  step: { gap: 2, backgroundColor: color.raised, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  bubble: { alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: color.raised, borderRadius: 16, borderBottomRightRadius: 4, paddingHorizontal: 12, paddingVertical: 6 },
});
