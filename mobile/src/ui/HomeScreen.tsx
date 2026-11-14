import { useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Host, Picker, Text as SwiftText } from '@expo/ui/swift-ui';
import { disabled, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { isParakeetLanguage, languageLabel } from '../languages';
import { recordingLimitSeconds, transcriptionReady } from '../providers';
import type { useMobileApp } from '../useMobileApp';
import { Button, Card, color, styles as kit, type } from './kit';
import { Markdown } from './Markdown';
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
  // The keyboard session holds the microphone, so the in-app recorder has nothing to offer until it ends.
  const sessionOn = app.keyboardSession.active;
  const showRecorder = !(sessionOn && idle);
  const setupCard = idle && !configured && !sessionOn;
  const line = (status && !restStatus.has(status) ? status : '') || busyLabel[phase] || '';

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

        {sessionOn ? <KeyboardSession app={app} onSetUp={() => onOpenSettings('keyboard')} /> : null}

        {setupCard ? (
          <Card>
            <Text style={type.headline}>{onDevice ? 'Download a speech model' : 'Set up transcription'}</Text>
            <Text style={type.footnote}>{onDevice ? localModelHint(app.localModel) : "Add your provider's key or endpoint. Use your computer's LAN address, not localhost."}</Text>
            <Button label="Open Settings" kind="primary" wide onPress={() => onOpenSettings('transcription')} />
          </Card>
        ) : null}

        {showRecorder ? (
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
        ) : null}

        {sessionOn ? null : <KeyboardSession app={app} onSetUp={() => onOpenSettings('keyboard')} />}

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

function RecordControl({ app, intent, configured }: { app: App; intent: Intent; configured: boolean }) {
  const { phase } = app;
  const agent = intent === 'agent';
  const tint = agent ? color.vermilion : color.blue;
  const shape = { borderRadius: agent ? 16 : 56 };

  if (phase === 'recording') {
    const m = Math.floor(app.elapsedSeconds / 60);
    const s = String(app.elapsedSeconds % 60).padStart(2, '0');
    // Ochre marks the approaching time limit, as on the desktop pill; recording stops on its own at zero.
    const left = recordingLimitSeconds(app.settings) - app.elapsedSeconds;
    const ending = left <= 10;
    return (
      <>
        <Pressable
          onPress={app.stopRecording}
          accessibilityRole="button"
          accessibilityLabel={agent ? 'Stop and send to agent' : 'Stop and transcribe'}
          style={({ pressed }) => [home.record, shape, { backgroundColor: tint }, pressed && { opacity: 0.8 }]}
        >
          <View style={home.stopGlyph} />
        </Pressable>
        <Text style={[type.title, home.timer, { color: ending ? color.ochre : tint }]} accessibilityLabel={`Recording, ${m} minutes ${s} seconds`}>
          {ending ? `Stops in ${Math.max(0, left)} s` : `${m}:${s}`}
        </Text>
        <Button label="Cancel" kind="ghost" onPress={app.cancel} />
      </>
    );
  }

  if (phase !== 'idle' && phase !== 'loading') {
    return (
      <>
        <View style={[home.record, home.recordIdle, shape, { borderColor: tint }]}>
          <ActivityIndicator color={tint} size="large" accessibilityLabel={busyLabel[phase]} />
        </View>
        <Button label="Cancel" kind="ghost" onPress={app.cancel} />
      </>
    );
  }

  const off = phase !== 'idle' || !configured || app.keyboardSession.active || app.keyboardSession.starting;
  const limit = recordingLimitSeconds(app.settings);
  return (
    <Pressable
      onPress={() => app.startRecording(intent)}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={agent ? 'Record agent command' : 'Start dictation'}
      accessibilityHint={`Records up to ${limit % 60 === 0 ? `${limit / 60} minutes` : `${limit} seconds`}`}
      accessibilityState={{ disabled: off }}
      style={({ pressed }) => [home.record, home.recordIdle, shape, { borderColor: tint }, pressed && { backgroundColor: color.raised }, off && { opacity: 0.4 }]}
    >
      <View style={[home.micGlyph, { backgroundColor: tint, borderRadius: agent ? 4 : 17 }]} />
    </Pressable>
  );
}

// Native owns the session; this only starts, shows, and stops it. The countdown keeps the open mic obvious.
function KeyboardSession({ app, onSetUp }: { app: App; onSetUp: () => void }) {
  const session = app.keyboardSession;
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
              {session.remainingSeconds === 0 && session.busy ? 'Finishing this utterance…' : 'Switch back and use the keyboard. Only audio between Dictate and Stop is kept.'}
            </Text>
          </View>
          <Text style={[type.title, home.timer, { color: session.remainingSeconds <= 60 ? color.ochre : color.blue }]} accessibilityLabel={`${m} minutes ${s} seconds left`}>
            {m}:{s}
          </Text>
        </View>
        <Button label="Stop Session" kind="destructive" wide onPress={() => { void app.stopKeyboardSession(); }} />
      </Card>
    );
  }
  const supported = isParakeetLanguage(app.settings.language);
  const ready = supported && app.localModel.kind === 'ready';
  const detail = session.endedReason ? `Last session ended: ${session.endedReason}`
    : app.preparingModel ? 'Preparing speech recognition…'
      : ready ? 'Use the Shuddhalekhan keyboard in any app for 10 minutes.'
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
  record: { width: 112, height: 112, alignItems: 'center', justifyContent: 'center' },
  recordIdle: { borderWidth: 2, backgroundColor: color.card },
  micGlyph: { width: 34, height: 34 },
  stopGlyph: { width: 32, height: 32, borderRadius: 5, backgroundColor: color.onSignal },
  timer: { fontVariant: ['tabular-nums'] },
  status: { textAlign: 'center', minHeight: 18 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  clear: { alignItems: 'center' },
  turn: { gap: 8, opacity: 0.75 },
  bubble: { alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: color.raised, borderRadius: 16, borderBottomRightRadius: 4, paddingHorizontal: 12, paddingVertical: 6 },
});
