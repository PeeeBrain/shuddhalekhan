import { useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { useMobileApp } from '../useMobileApp';
import { Button, Card, Segment, color, styles as kit, type } from './kit';

type App = ReturnType<typeof useMobileApp>;
type Intent = App['intent'];

const busyLabel: Partial<Record<App['phase'], string>> = {
  loading: 'Loading settings…',
  requestingPermission: 'Waiting for microphone permission…',
  transcribing: 'Transcribing…',
  running: 'Agent is working…',
  awaitingApproval: 'Waiting for your approval…',
};

export function HomeScreen({ app, onOpenSettings }: { app: App; onOpenSettings: () => void }) {
  const { settings, phase, transcript, response, status, error } = app;
  const [picked, setPicked] = useState<Intent>('dictation');
  const idle = phase === 'idle';
  // While a run is in flight the hook's intent is the truth; the picker only matters at rest.
  const intent: Intent = idle ? (settings.agentEnabled ? picked : 'dictation') : app.intent;
  const agent = intent === 'agent';
  const onDevice = settings.transcriptionSource === 'on-device';
  const configured = onDevice ? app.localModel.kind === 'ready' : settings.transcriptionEndpoint.trim() !== '' &&
    (!settings.transcriptionEndpoint.startsWith('https://api.openai.com/') || settings.transcriptionKey !== '');
  const setupHint = onDevice ? localModelHint(app.localModel) : 'Add a transcription API key or endpoint in Settings.';
  const canRetry = idle && settings.agentEnabled && transcript.trim() !== '';

  return (
    <SafeAreaView style={home.screen} edges={['top', 'left', 'right']}>
      <View style={home.header}>
        <Text style={[type.largeTitle, { flexShrink: 1 }]} accessibilityRole="header">
          Shuddhalekhan
        </Text>
        <Button label="Settings" kind="ghost" onPress={onOpenSettings} disabled={!idle} />
      </View>

      <ScrollView contentContainerStyle={home.content} contentInsetAdjustmentBehavior="automatic">
        {error ? (
          <View style={home.error} accessibilityRole="alert">
            <Text style={[type.body, { color: color.red }]} selectable>
              {error}
            </Text>
            {phase !== 'loading' ? <Button label="Dismiss" kind="ghost" onPress={app.dismissError} /> : (
              <Button label="Reset saved settings" kind="destructive" onPress={() => Alert.alert(
                'Reset saved settings?',
                'This removes your saved provider settings, API keys, and MCP configuration. You will need to enter them again.',
                [{ text: 'Cancel', style: 'cancel' }, { text: 'Reset settings', style: 'destructive', onPress: () => { void app.resetSettings(); } }],
              )} />
            )}
          </View>
        ) : null}

        {idle && !configured ? (
          <Card>
            <Text style={type.headline}>{onDevice ? 'Set up on-device transcription' : 'Set up transcription'}</Text>
            <Text style={type.footnote}>
              {onDevice ? setupHint : "Add your transcription API key or Whisper-compatible endpoint in Settings. On your phone, use your computer's LAN address instead of localhost."}
            </Text>
            <Button label="Open Settings" kind="primary" onPress={onOpenSettings} />
          </Card>
        ) : null}

        {settings.agentEnabled ? (
          <View style={kit.segments} accessibilityRole="radiogroup" accessibilityLabel="Mode">
            <Segment label="Dictation" selected={!agent} disabled={!idle} onPress={() => setPicked('dictation')} />
            <Segment label="Agent" agent selected={agent} disabled={!idle} onPress={() => setPicked('agent')} />
          </View>
        ) : null}

        <RecordControl app={app} intent={intent} configured={configured} setupHint={setupHint} />

        <Text style={[type.footnote, home.status]} accessibilityLiveRegion="polite" selectable>
          {idle && !configured ? setupHint : status || busyLabel[phase] || (agent ? 'Speak one command for the agent.' : 'Tap to dictate.')}
        </Text>

        <KeyboardSessionCard app={app} onOpenSettings={onOpenSettings} />

        {transcript ? (
          <Card>
            <Text style={type.caption} accessibilityRole="header">
              Transcript
            </Text>
            <Text style={type.body} selectable>
              {transcript}
            </Text>
            <View style={kit.row}>
              <CopyShare text={transcript} what="transcript" />
            </View>
            {canRetry ? (
              <Button
                label="Send to agent"
                kind="secondary"
                onPress={app.retryAgent}
                accessibilityHint="Runs Agent Mode again with this transcript"
              />
            ) : null}
          </Card>
        ) : null}

        {response ? (
          <Card agent>
            <Text style={[type.caption, { color: color.vermilion }]} accessibilityRole="header">
              Agent response
            </Text>
            <Text style={type.body} selectable>
              {response}
            </Text>
            <View style={kit.row}>
              <CopyShare text={response} what="agent response" />
            </View>
          </Card>
        ) : null}

        {idle && (transcript || response) ? <Button label="Clear" kind="ghost" onPress={app.clearResults} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function RecordControl({ app, intent, configured, setupHint }: { app: App; intent: Intent; configured: boolean; setupHint: string }) {
  const { phase } = app;
  const agent = intent === 'agent';
  const tint = agent ? color.vermilion : color.blue;

  if (phase === 'recording') {
    const m = Math.floor(app.elapsedSeconds / 60);
    const s = String(app.elapsedSeconds % 60).padStart(2, '0');
    return (
      <View style={home.recordWrap}>
        <Pressable
          onPress={app.stopRecording}
          accessibilityRole="button"
          accessibilityLabel={agent ? 'Stop and send to agent' : 'Stop and transcribe'}
          style={({ pressed }) => [home.record, { backgroundColor: tint, borderRadius: agent ? 10 : 44 }, pressed && { opacity: 0.8 }]}
        >
          <View style={home.stopGlyph} />
        </Pressable>
        <Text style={[type.title, home.timer, { color: tint }]} accessibilityLabel={`Recording, ${m} minutes ${s} seconds`}>
          {m}:{s}
        </Text>
        <Button label="Cancel" kind="ghost" onPress={app.cancel} accessibilityHint="Discards this recording" />
      </View>
    );
  }

  if (phase !== 'idle' && phase !== 'loading') {
    return (
      <View style={home.recordWrap}>
        <View style={[home.record, home.recordIdle, { borderColor: tint, borderRadius: agent ? 10 : 44 }]}>
          <ActivityIndicator color={tint} accessibilityLabel={busyLabel[phase]} />
        </View>
        <Button label="Cancel" kind="ghost" onPress={app.cancel} />
      </View>
    );
  }

  const disabled = phase !== 'idle' || !configured || app.keyboardSession.active;
  return (
    <View style={home.recordWrap}>
      <Pressable
        onPress={() => app.startRecording(intent)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={agent ? 'Record agent command' : 'Start dictation'}
        accessibilityHint={configured ? undefined : setupHint}
        accessibilityState={{ disabled }}
        style={({ pressed }) => [
          home.record,
          home.recordIdle,
          { borderColor: tint, borderRadius: agent ? 10 : 44 },
          pressed && { backgroundColor: color.raised },
          disabled && { opacity: 0.45 },
        ]}
      >
        <View style={[home.micGlyph, { backgroundColor: tint, borderRadius: agent ? 3 : 10 }]} />
      </Pressable>
      <Text style={[type.headline, { color: tint }]}>{agent ? 'Ask agent' : 'Dictate'}</Text>
      <Text style={type.footnote}>{app.keyboardSession.active ? 'Stop the keyboard session to record here.' : 'Record up to five minutes.'}</Text>
    </View>
  );
}

// Native owns the session; this only starts, shows, and stops it. The countdown keeps the open mic obvious.
function KeyboardSessionCard({ app, onOpenSettings }: { app: App; onOpenSettings: () => void }) {
  const session = app.keyboardSession;
  if (!session.available) return null;
  if (session.active) {
    const m = Math.floor(session.remainingSeconds / 60);
    const s = String(session.remainingSeconds % 60).padStart(2, '0');
    return (
      <Card>
        <Text style={type.headline} accessibilityRole="header">Keyboard session on</Text>
        <Text style={[type.title, home.timer, { color: color.blue }]} accessibilityLabel={`${m} minutes ${s} seconds left`}>
          {m}:{s}
        </Text>
        <Text style={type.footnote}>
          The microphone stays open until the timer ends or you stop, and iOS shows the recording indicator. Audio is kept only
          between Dictate and Stop on the Shuddhalekhan keyboard, and it is transcribed on this iPhone.
        </Text>
        <Button label="Stop session" kind="destructive" onPress={() => { void app.stopKeyboardSession(); }} />
      </Card>
    );
  }
  const ready = app.localModel.kind === 'ready';
  return (
    <Card>
      <Text style={type.headline} accessibilityRole="header">Dictate in any app</Text>
      <Text style={type.footnote}>
        {ready
          ? 'Start a 10-minute session, then switch apps and use the Shuddhalekhan keyboard: tap Dictate, speak, and tap Stop. The text is typed at the cursor.'
          : 'Keyboard dictation runs on this iPhone. Download Parakeet in Settings first.'}
      </Text>
      {session.endedReason ? <Text style={[type.footnote, { color: color.red }]}>Last session ended: {session.endedReason}</Text> : null}
      <Button
        label={session.starting ? 'Starting…' : 'Start keyboard session'}
        kind="primary"
        disabled={!ready || session.starting || app.phase !== 'idle'}
        onPress={async () => {
          try { await app.startKeyboardSession(); }
          catch (e) { Alert.alert('Keyboard session', e instanceof Error ? e.message : 'Could not start the session.'); }
        }}
      />
      <Button label="Keyboard setup" kind="ghost" onPress={onOpenSettings} disabled={app.phase !== 'idle'} accessibilityHint="Opens Settings with steps to add the Shuddhalekhan keyboard" />
    </Card>
  );
}

function localModelHint(model: App['localModel']): string {
  switch (model.kind) {
    case 'checking': return 'Checking the installed on-device model…';
    case 'ready': return '';
    case 'downloading': return `Downloading the on-device model (${Math.round(model.fraction * 100)}%). You can record once it is ready.`;
    case 'installing': return 'Preparing the on-device model for this iPhone. The first time can take a few minutes.';
    case 'unavailable': return 'Install the updated native app to use on-device Parakeet, or switch to an endpoint in Settings.';
    case 'error': return 'The on-device model could not be installed. Retry in Settings.';
    case 'missing': return 'Download the Parakeet model (about 480 MB) in Settings to record on this iPhone.';
  }
}

function CopyShare({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button
        label={copied ? 'Copied' : 'Copy'}
        accessibilityLabel={`Copy ${what}`}
        onPress={async () => {
          try {
            await Clipboard.setStringAsync(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch { Alert.alert('Could not copy', 'Try selecting the text and copying it.'); }
        }}
      />
      <Button label="Share" accessibilityLabel={`Share ${what}`} onPress={() => {
        void Share.share({ message: text }).catch(() => Alert.alert('Could not share', 'Try copying the text instead.'));
      }} />
    </>
  );
}

const home = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.page },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  content: { padding: 20, gap: 16, paddingBottom: 48 },
  error: {
    backgroundColor: color.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: color.red,
    padding: 16,
    gap: 8,
  },
  recordWrap: { alignItems: 'center', gap: 12, paddingVertical: 16 },
  record: { width: 88, height: 88, alignItems: 'center', justifyContent: 'center' },
  recordIdle: { borderWidth: 2, backgroundColor: color.card },
  micGlyph: { width: 28, height: 28 },
  stopGlyph: { width: 26, height: 26, borderRadius: 4, backgroundColor: color.onSignal },
  timer: { fontVariant: ['tabular-nums'] },
  status: { textAlign: 'center' },
});
