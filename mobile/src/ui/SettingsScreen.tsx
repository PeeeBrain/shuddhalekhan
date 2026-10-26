import { useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { LocalModelState } from '../on-device';
import { settingsError, type MCPServerSettings, type MobileSettings } from '../settings';
import { Button, Card, Field, Section, Segment, ToggleRow, color, styles as kit, type } from './kit';

const LAN_HINT =
  "Enter the full URL including the path. On this phone, localhost is the phone itself: use your computer's LAN IP, e.g. http://192.168.1.20:8080/inference.";

export function SettingsScreen({
  settings,
  localModel,
  onInstallLocalModel,
  canSave,
  onSave,
  onClose,
}: {
  settings: MobileSettings;
  localModel: LocalModelState;
  onInstallLocalModel: () => Promise<void>;
  canSave: boolean;
  onSave: (settings: MobileSettings) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof MobileSettings>(key: K, value: MobileSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setServer = (id: string, patch: Partial<MCPServerSettings>) =>
    set('mcpServers', draft.mcpServers.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } catch (e) {
      Alert.alert('Not saved', settingsError(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleInsecure = (on: boolean) => {
    if (!on) return set('allowInsecureHTTP', false);
    Alert.alert(
      'Allow unencrypted HTTP?',
      'Recorded audio, transcripts, API keys, and MCP tokens will travel unencrypted. Anyone on the same network can read them. Only use this on a network you trust.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Allow HTTP', style: 'destructive', onPress: () => set('allowInsecureHTTP', true) },
      ],
    );
  };

  return (
    <SafeAreaView style={s.screen} edges={['top', 'left', 'right']}>
      <View style={s.header}>
        <Button label="Cancel" kind="ghost" onPress={onClose} disabled={saving} />
        <Text style={type.headline} accessibilityRole="header">
          Settings
        </Text>
        <Button label={saving ? 'Saving…' : 'Save'} kind="ghost" onPress={save} disabled={!canSave || saving} />
      </View>

      <ScrollView
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
      >
        <Section title="Transcription" footer="Used by both Dictation and Agent Mode. Switching source keeps your endpoint settings.">
          <View style={kit.segments} accessibilityRole="radiogroup" accessibilityLabel="Transcription source">
            <Segment label="Endpoint" selected={draft.transcriptionSource === 'endpoint'} onPress={() => set('transcriptionSource', 'endpoint')} />
            <Segment label="On this iPhone" selected={draft.transcriptionSource === 'on-device'} onPress={() => set('transcriptionSource', 'on-device')} />
          </View>
          {draft.transcriptionSource === 'on-device' ? (
            <LocalModel model={localModel} onInstall={onInstallLocalModel} />
          ) : (
            <>
              <Field
                label="Endpoint"
                value={draft.transcriptionEndpoint}
                onChangeText={(v) => set('transcriptionEndpoint', v)}
                placeholder="http://192.168.1.20:8080/inference"
                keyboardType="url"
                hint={LAN_HINT}
              />
              <Field label="Model" value={draft.transcriptionModel} onChangeText={(v) => set('transcriptionModel', v)} placeholder="Optional" />
              <Field label="API key" secret value={draft.transcriptionKey} onChangeText={(v) => set('transcriptionKey', v)} placeholder="Optional" />
              <Field label="Language" value={draft.language} onChangeText={(v) => set('language', v)} placeholder="Auto" />
              <Field
                label="Dictionary"
                value={draft.dictionary}
                onChangeText={(v) => set('dictionary', v)}
                multiline
                placeholder="Names and terms to spell correctly"
              />
            </>
          )}
        </Section>

        <Section
          title="Keyboard"
          footer="iOS doesn't let keyboards use the microphone or open this app, so recording happens here during a session you start. Password fields and some apps always use the system keyboard."
        >
          <Text style={type.body}>Dictate into any app with the Shuddhalekhan keyboard.</Text>
          <Text style={type.footnote}>1. In iOS Settings, go to General › Keyboard › Keyboards › Add New Keyboard › Shuddhalekhan.</Text>
          <Text style={type.footnote}>
            2. Tap Shuddhalekhan and turn on Allow Full Access. The keyboard uses it only to exchange start, stop, and the
            finished text with this app over a connection confined to this iPhone. It cannot use the microphone.
          </Text>
          <Text style={type.footnote}>
            3. Download Parakeet, then tap Start keyboard session on the home screen. In any app, switch to the Shuddhalekhan
            keyboard with the globe key, tap Dictate, speak, and tap Stop.
          </Text>
        </Section>

        <Section title="Agent Mode" footer="One spoken command, one run. No chat history.">
          <ToggleRow label="Enable Agent Mode" value={draft.agentEnabled} onValueChange={(v) => set('agentEnabled', v)} />
          {draft.agentEnabled ? (
            <>
              <Field
                label="Chat completions endpoint"
                value={draft.agentEndpoint}
                onChangeText={(v) => set('agentEndpoint', v)}
                placeholder="https://api.openai.com/v1/chat/completions"
                keyboardType="url"
                hint="Full OpenAI-compatible chat completions URL. For LM Studio: http://<computer IP>:1234/v1/chat/completions with Serve on Local Network on in LM Studio and Allow unencrypted HTTP on below."
              />
              <Field
                label="Model"
                value={draft.agentModel}
                onChangeText={(v) => set('agentModel', v)}
                hint="Exact model ID, e.g. the model loaded in LM Studio."
              />
              <Field
                label="API key"
                secret
                value={draft.agentKey}
                onChangeText={(v) => set('agentKey', v)}
                placeholder="Optional if your server needs none"
              />
              <Field label="System prompt" value={draft.systemPrompt} onChangeText={(v) => set('systemPrompt', v)} multiline />
            </>
          ) : null}
        </Section>

        {draft.agentEnabled ? (
          <View style={kit.section}>
            <Text style={[type.caption, kit.sectionTitle]} accessibilityRole="header">
              MCP servers (HTTP)
            </Text>
            {draft.mcpServers.map((server) => (
              <Card key={server.id}>
                <ToggleRow
                  label={server.name || 'Untitled server'}
                  hint="Tools ask for approval every time."
                  value={server.enabled}
                  onValueChange={(enabled) => setServer(server.id, { enabled })}
                />
                <Field label="Name" value={server.name} onChangeText={(name) => setServer(server.id, { name })} />
                <Field
                  label="Endpoint"
                  value={server.endpoint}
                  onChangeText={(endpoint) => setServer(server.id, { endpoint })}
                  placeholder="http://192.168.1.20:3000/mcp"
                  keyboardType="url"
                />
                <Field
                  label="Bearer token"
                  secret
                  value={server.token}
                  onChangeText={(token) => setServer(server.id, { token })}
                  placeholder="Optional"
                />
                <Button
                  label="Remove server"
                  kind="destructive"
                  accessibilityLabel={`Remove ${server.name || 'untitled server'}`}
                  onPress={() => set('mcpServers', draft.mcpServers.filter((x) => x.id !== server.id))}
                />
              </Card>
            ))}
            <Button
              label="Add MCP server"
              disabled={draft.mcpServers.length >= 10}
              onPress={() =>
                set('mcpServers', [
                  ...draft.mcpServers,
                  { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: '', endpoint: '', token: '', enabled: true },
                ])
              }
            />
            <Text style={[type.footnote, kit.sectionFooter]}>{LAN_HINT.replace('8080/inference', '3000/mcp')}</Text>
          </View>
        ) : null}

        <Section title="Network">
          <ToggleRow
            label="Allow unencrypted HTTP"
            hint={
              draft.allowInsecureHTTP
                ? 'On: audio, keys, and tokens can be read by anyone on your network.'
                : 'Needed for http:// endpoints on your LAN.'
            }
            value={draft.allowInsecureHTTP}
            onValueChange={toggleInsecure}
          />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

// Status and install action for the on-device Parakeet model. Install runs outside the Settings draft.
function LocalModel({ model, onInstall }: { model: LocalModelState; onInstall: () => Promise<void> }) {
  const confirmInstall = () =>
    Alert.alert(
      'Download about 480 MB?',
      'Shuddhalekhan downloads the Parakeet v3 model and installs it in the app. Use Wi-Fi; cellular data charges may apply. After downloading, iOS prepares the model for this iPhone, which can take a few minutes the first time.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Download', onPress: () => { void onInstall(); } },
      ],
    );
  const languages = 'Parakeet v3 supports 25 European languages, including English. It does not support Hindi or Marathi; use an endpoint for those.';

  switch (model.kind) {
    case 'checking':
      return <Text style={type.footnote}>Checking the installed model…</Text>;
    case 'unavailable':
      return <Text style={type.footnote}>Install the updated native app to use on-device Parakeet. It requires iOS 17 or later.</Text>;
    case 'missing':
      return (
        <>
          <Text style={type.footnote}>Needs a one-time download of about 480 MB. Once installed, transcription runs on this iPhone. {languages}</Text>
          <Button label="Download model…" kind="primary" onPress={confirmInstall} />
        </>
      );
    case 'downloading':
    case 'installing': {
      const percent = Math.round(model.fraction * 100);
      const label = model.kind === 'downloading' ? `Downloading model… ${percent}%` : 'Preparing model for this iPhone…';
      return (
        <>
          <View style={s.progressRow}>
            <ActivityIndicator color={color.blue} />
            <Text style={[type.body, { flex: 1 }]} accessibilityLiveRegion="polite">{label}</Text>
          </View>
          <View style={s.track} accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: percent }}>
            <View style={[s.fill, { width: `${percent}%` }]} />
          </View>
          <Text style={type.footnote}>
            {model.kind === 'downloading'
              ? 'Keep Shuddhalekhan open until the download finishes.'
              : 'The first time can take a few minutes. You can record once the model is ready.'}
          </Text>
        </>
      );
    }
    case 'ready':
      return (
        <Text style={type.footnote}>
          <Text style={{ color: color.green }}>Model installed. </Text>
          Agent Mode still sends the transcript to your agent endpoint. {languages}
        </Text>
      );
    case 'error':
      return (
        <>
          <Text style={[type.footnote, { color: color.red }]} accessibilityRole="alert" selectable>
            {model.message}
          </Text>
          <Button label="Retry download…" kind="primary" onPress={confirmInstall} />
        </>
      );
  }
}

const s = StyleSheet.create({
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  track: { height: 4, borderRadius: 2, backgroundColor: color.hairline, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: color.blue },
  screen: { flex: 1, backgroundColor: color.page },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  content: { padding: 20, gap: 24, paddingBottom: 64 },
});
