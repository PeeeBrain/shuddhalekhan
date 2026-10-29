import { useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SARVAM_MODELS, SARVAM_MODES } from '../../../app/src/shared/sarvam';
import { normalizeLanguage, parakeetLanguages, speechLanguages } from '../languages';
import { localModelKey, type LocalModelState } from '../on-device';
import { agentProviders, selectAgentApiMode, selectAgentProvider, selectTranscriptionProvider, transcriptionProviders } from '../providers';
import { settingsError, type MCPServerSettings, type MobileSettings } from '../settings';
import { Button, Card, Choice, Field, Section, Segment, ToggleRow, color, styles as kit, type } from './kit';
import { MCPToolPolicies } from './MCPToolPolicies';

const LAN_HINT =
  "Enter the full URL including the path. On this phone, localhost is the phone itself: use your computer's LAN IP, e.g. http://192.168.1.20:8080/inference.";

type Set = <K extends keyof MobileSettings>(key: K, value: MobileSettings[K]) => void;
type Update = (update: (d: MobileSettings) => MobileSettings) => void;

export function SettingsScreen({
  settings,
  localModels,
  preparingModel,
  onInstallLocalModel,
  canSave,
  onSave,
  onClose,
}: {
  settings: MobileSettings;
  localModels: Record<'english' | 'multilingual', LocalModelState>;
  preparingModel: boolean;
  onInstallLocalModel: (language: string) => Promise<void>;
  canSave: boolean;
  onSave: (settings: MobileSettings) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const set: Set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const setServer = (id: string, patch: Partial<MCPServerSettings>) =>
    set('mcpServers', draft.mcpServers.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const localKey = localModelKey(draft.language);

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

  // Cancel never drops typed credentials or endpoints without asking.
  const cancel = () => {
    if (JSON.stringify(draft) === JSON.stringify(settings)) return onClose();
    Alert.alert('Discard changes?', 'Your unsaved settings changes will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onClose },
    ]);
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
    <SafeAreaView style={s.screen}>
      <View style={s.header}>
        <Button label="Cancel" kind="ghost" onPress={cancel} disabled={saving} />
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
            <>
              <Choice
                label="Language"
                value={draft.language}
                options={localLanguages}
                onChange={(v) => set('language', v)}
                hint="English uses the English-only Parakeet v2 model. Other languages use Parakeet v3 with a language hint. Auto-detect uses v3 without one."
              />
              <LocalModel
                model={localModels[localKey]}
                preparing={preparingModel}
                english={localKey === 'english'}
                onInstall={() => onInstallLocalModel(normalizeLanguage(draft.language))}
              />
            </>
          ) : (
            <RemoteTranscription draft={draft} set={set} setDraft={setDraft} />
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
            3. Download Parakeet for your language, then tap Start keyboard session on the home screen. In any app, switch to the
            Shuddhalekhan keyboard with the globe key, tap Dictate, speak, and tap Stop. The keyboard always transcribes on this
            iPhone, even when an endpoint is selected above.
          </Text>
        </Section>

        <Section title="Agent Mode" footer="One spoken command, one run. No chat history.">
          <ToggleRow label="Enable Agent Mode" value={draft.agentEnabled} onValueChange={(v) => set('agentEnabled', v)} />
          {draft.agentEnabled ? (
            <>
              <AgentProvider draft={draft} set={set} setDraft={setDraft} />
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
                  hint="New tools ask for approval. Choose exceptions in Tool approval policies."
                  value={server.enabled}
                  onValueChange={(enabled) => setServer(server.id, { enabled })}
                />
                <Field label="Name" value={server.name} onChangeText={(name) => setServer(server.id, { name })} />
                <Field
                  label="Endpoint"
                  value={server.endpoint}
                  onChangeText={(endpoint) => setServer(server.id, { endpoint, toolPolicies: {} })}
                  hint="Changing the endpoint resets this server's tool policies."
                  placeholder="http://192.168.1.20:3000/mcp"
                  keyboardType="url"
                />
                <Field
                  label="Bearer token"
                  secret
                  value={server.token}
                  onChangeText={(token) => setServer(server.id, { token, toolPolicies: {} })}
                  hint="Changing the credential resets this server's tool policies."
                  placeholder="Optional"
                />
                <MCPToolPolicies server={server} allowHTTP={draft.allowInsecureHTTP} onChange={toolPolicies => setServer(server.id, { toolPolicies })} />
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

const localLanguages = [{ value: '', label: 'Auto-detect' }, ...parakeetLanguages];
const remoteLanguages = [{ value: '', label: 'Auto-detect' }, ...speechLanguages];
const typedLanguage = (query: string) => {
  const code = normalizeLanguage(query);
  return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(code) ? { value: code, label: `Use language code ${code}` } : null;
};
const sarvamModes: Record<(typeof SARVAM_MODES)[number], string> = {
  transcribe: 'Transcribe', verbatim: 'Verbatim', translit: 'Transliterate', codemix: 'Code-mixed',
};
const transcriptionAuth = [{ value: 'none', label: 'None' }, { value: 'bearer', label: 'Bearer token' }, { value: 'header', label: 'Custom header' }];
const agentAuth = [{ value: 'none', label: 'None' }, { value: 'bearer', label: 'Bearer token' }, { value: 'api-key', label: 'api-key header' }];
const reasoning = ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value === 'default' ? 'Provider default' : value }));

// Per-provider fields: only what the selected provider's request uses.
function RemoteTranscription({ draft, set, setDraft }: { draft: MobileSettings; set: Set; setDraft: Update }) {
  const provider = draft.transcriptionProvider;
  const preset = transcriptionProviders.find((p) => p.value === provider);
  const keyed = provider === 'openai' || provider === 'sarvam' || provider === 'azure-speech';
  const auth = provider === 'custom-open-ai-compatible' || provider === 'nvidia-speech-nim' ? transcriptionAuth
    : provider === 'whisper-live-kit' ? transcriptionAuth.slice(0, 2) : null;
  const usesDictionary = provider !== 'whisper-live-kit' && (provider !== 'nvidia-speech-nim' || draft.nimDictionary);
  return (
    <>
      <Choice
        label="Provider"
        value={provider}
        options={transcriptionProviders}
        onChange={(v) => setDraft((d) => selectTranscriptionProvider(d, v as MobileSettings['transcriptionProvider']))}
        hint="Switching provider clears its saved credentials."
      />
      {preset?.placeholder ? (
        <Field
          label={provider === 'azure-speech' ? 'Resource endpoint' : 'Endpoint'}
          value={draft.transcriptionEndpoint}
          onChangeText={(v) => set('transcriptionEndpoint', v)}
          placeholder={preset.placeholder}
          keyboardType="url"
          hint={provider === 'azure-speech' ? 'Or leave empty and enter the region below.' : LAN_HINT}
        />
      ) : null}
      {provider === 'azure-speech' ? (
        <Field label="Region" value={draft.azureRegion} onChangeText={(v) => set('azureRegion', v)} placeholder="centralindia" />
      ) : null}
      {provider === 'google-cloud-speech-v2' ? (
        <>
          <Field label="Project ID" value={draft.googleProject} onChangeText={(v) => set('googleProject', v)} />
          <Field
            label="Location"
            value={draft.googleLocation}
            onChangeText={(v) => set('googleLocation', v)}
            placeholder="global"
            hint="Chirp 3 runs in multi-regions such as us or eu."
          />
          <Field
            label="Service-account JSON"
            value={draft.googleServiceAccount}
            onChangeText={(v) => set('googleServiceAccount', v)}
            multiline
            hint="Stored in the iOS Keychain. Its private key signs the token request on this iPhone and is never sent."
          />
        </>
      ) : null}
      {provider === 'sarvam' ? (
        <>
          <Choice
            label="Model"
            value={draft.transcriptionModel}
            options={SARVAM_MODELS.map((value) => ({ value, label: value }))}
            onChange={(v) => set('transcriptionModel', v)}
          />
          <Choice
            label="Mode"
            value={draft.sarvamMode}
            options={SARVAM_MODES.map((value) => ({ value, label: sarvamModes[value] }))}
            onChange={(v) => set('sarvamMode', v as MobileSettings['sarvamMode'])}
          />
        </>
      ) : provider !== 'azure-speech' && provider !== 'local-whisper-cpp' ? (
        <Field label="Model" value={draft.transcriptionModel} onChangeText={(v) => set('transcriptionModel', v)} placeholder={preset?.model || 'Optional'} />
      ) : null}
      {auth ? (
        <Choice
          label="Authentication"
          value={draft.transcriptionAuth}
          options={auth}
          onChange={(v) => set('transcriptionAuth', v as MobileSettings['transcriptionAuth'])}
        />
      ) : null}
      {auth && draft.transcriptionAuth === 'header' ? (
        <Field label="Header name" value={draft.transcriptionHeaderName} onChangeText={(v) => set('transcriptionHeaderName', v)} />
      ) : null}
      {keyed || (auth && draft.transcriptionAuth !== 'none') ? (
        <Field label="API key" secret value={draft.transcriptionKey} onChangeText={(v) => set('transcriptionKey', v)} />
      ) : null}
      <Choice
        label="Language"
        value={draft.language}
        options={provider === 'google-cloud-speech-v2' ? speechLanguages : remoteLanguages}
        onChange={(v) => set('language', v)}
        custom={typedLanguage}
        hint="A regional variant such as English (India) helps providers that use locales (Azure, Google, NVIDIA). Others receive the base language."
      />
      {provider === 'nvidia-speech-nim' ? (
        <>
          <ToggleRow
            label="Allow automatic language"
            value={draft.nimAutoLanguage}
            onValueChange={(v) => set('nimAutoLanguage', v)}
            hint="Only for NIM models that detect the language."
          />
          <ToggleRow
            label="Send dictionary as prompt"
            value={draft.nimDictionary}
            onValueChange={(v) => set('nimDictionary', v)}
            hint="Only for NIM models that accept a prompt."
          />
        </>
      ) : null}
      {usesDictionary ? (
        <Field
          label="Dictionary"
          value={draft.dictionary}
          onChangeText={(v) => set('dictionary', v)}
          multiline
          placeholder="Names and terms to spell correctly"
        />
      ) : null}
    </>
  );
}

function AgentProvider({ draft, set, setDraft }: { draft: MobileSettings; set: Set; setDraft: Update }) {
  const provider = draft.agentProvider;
  const native = provider === 'openai' || provider === 'azure-openai';
  return (
    <>
      <Choice
        label="Provider"
        value={provider}
        options={agentProviders}
        onChange={(v) => setDraft((d) => selectAgentProvider(d, v as MobileSettings['agentProvider']))}
        hint="Switching provider clears its saved key."
      />
      {native ? (
        <View style={kit.segments} accessibilityRole="radiogroup" accessibilityLabel="API">
          <Segment label="Responses" selected={draft.agentApiMode === 'responses'} onPress={() => setDraft((d) => selectAgentApiMode(d, 'responses'))} />
          <Segment label="Chat Completions" selected={draft.agentApiMode === 'chat-completions'} onPress={() => setDraft((d) => selectAgentApiMode(d, 'chat-completions'))} />
        </View>
      ) : null}
      <Field
        label="Endpoint"
        value={draft.agentEndpoint}
        onChangeText={(v) => set('agentEndpoint', v)}
        placeholder={agentProviders.find((p) => p.value === provider)?.placeholder || 'https://'}
        keyboardType="url"
        hint={provider === 'openai-compatible'
          ? 'Full OpenAI-compatible chat completions URL. For LM Studio: http://<computer IP>:1234/v1/chat/completions with Serve on Local Network on in LM Studio and Allow unencrypted HTTP on below.'
          : 'Full request URL.'}
      />
      <Field
        label={provider === 'azure-openai' ? 'Deployment name' : 'Model'}
        value={draft.agentModel}
        onChangeText={(v) => set('agentModel', v)}
        hint={provider === 'openai-compatible' ? 'Exact model ID, e.g. the model loaded in LM Studio.' : undefined}
      />
      {provider === 'azure-openai' || provider === 'openai-compatible' ? (
        <Choice
          label="Authentication"
          value={draft.agentAuth}
          options={provider === 'azure-openai' ? agentAuth.slice(1) : agentAuth}
          onChange={(v) => set('agentAuth', v as MobileSettings['agentAuth'])}
        />
      ) : null}
      {draft.agentAuth !== 'none' ? (
        <Field
          label="API key"
          secret
          value={draft.agentKey}
          onChangeText={(v) => set('agentKey', v)}
          placeholder={provider === 'openai-compatible' ? 'Optional if your server needs none' : undefined}
        />
      ) : null}
      <Choice
        label="Reasoning effort"
        value={draft.agentReasoning}
        options={reasoning}
        onChange={(v) => set('agentReasoning', v as MobileSettings['agentReasoning'])}
        hint="Provider default sends nothing. A model that does not accept the chosen effort fails the run."
      />
      {native ? (
        <ToggleRow
          label="Prompt caching"
          value={draft.agentCache}
          onValueChange={(v) => set('agentCache', v)}
          hint="Marks the system prompt and latest inputs as cache breakpoints."
        />
      ) : null}
    </>
  );
}

// Status and install action for the Parakeet model the selected language uses. Install runs outside the Settings draft.
function LocalModel({ model, english, preparing, onInstall }: { model: LocalModelState; english: boolean; preparing: boolean; onInstall: () => Promise<void> }) {
  const name = english ? 'Parakeet v2 (English)' : 'Parakeet v3 (multilingual)';
  const confirmInstall = () =>
    Alert.alert(
      'Download about 0.5 GB?',
      `Shuddhalekhan downloads the ${name} model and installs it in the app. Each model is a separate download. Use Wi-Fi; cellular data charges may apply. After downloading, iOS prepares the model for this iPhone, which can take a few minutes the first time.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Download', onPress: () => { void onInstall(); } },
      ],
    );
  const languages = 'Parakeet supports 25 European languages. It does not support Hindi or Marathi; use an endpoint for those.';

  switch (model.kind) {
    case 'checking':
      return <Text style={type.footnote}>Checking the installed model…</Text>;
    case 'unavailable':
      return <Text style={type.footnote}>Install the updated native app to use on-device Parakeet. It requires iOS 17 or later.</Text>;
    case 'missing':
      return (
        <>
          <Text style={type.footnote}>{name} needs a one-time download of about 0.5 GB. Once installed, transcription runs on this iPhone. {languages}</Text>
          {preparing ? <Text style={type.footnote}>Preparing the installed model. Wait for preparation to finish before downloading another.</Text> : null}
          <Button label="Download model…" kind="primary" onPress={confirmInstall} disabled={preparing} />
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
          <Text style={{ color: color.green }}>{name} installed. </Text>
          Agent Mode still sends the transcript to your agent endpoint. {languages}
        </Text>
      );
    case 'error':
      return (
        <>
          <Text style={[type.footnote, { color: color.red }]} accessibilityRole="alert" selectable>
            {model.message}
          </Text>
          {preparing ? <Text style={type.footnote}>Preparing the installed model. Wait for preparation to finish before downloading another.</Text> : null}
          <Button label="Retry download…" kind="primary" onPress={confirmInstall} disabled={preparing} />
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
