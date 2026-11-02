import { useEffect, useState } from 'react';
import { Alert } from 'react-native';
import {
  Button, Form, Host, LabeledContent, Label, Link, NavigationDestination, NavigationLink, NavigationStack, Picker, ProgressView,
  Section, SecureField, Text, TextField, Toggle, Toolbar, ToolbarItem, useNativeState,
} from '@expo/ui/swift-ui';
import {
  autocorrectionDisabled, disabled, foregroundStyle, keyboardType, lineLimit, multilineTextAlignment, navigationTitle, pickerStyle,
  scrollDismissesKeyboard, tag, textContentType, textInputAutocapitalization, tint,
} from '@expo/ui/swift-ui/modifiers';
import { SARVAM_MODELS, SARVAM_MODES } from '../../../app/src/shared/sarvam';
import type { ChatGptModel } from '../chatgpt';
import { normalizeLanguage, parakeetLanguages, speechLanguages } from '../languages';
import { localModelKey, type LocalModelState } from '../on-device';
import { agentProviders, selectAgentApiMode, selectAgentProvider, selectTranscriptionProvider, transcriptionProviders } from '../providers';
import { settingsError, type MCPServerSettings, type MobileSettings } from '../settings';
import type { useMobileApp } from '../useMobileApp';
import { color } from './kit';
import { MCPToolPolicies } from './MCPToolPolicies';

type App = ReturnType<typeof useMobileApp>;
type Set = <K extends keyof MobileSettings>(key: K, value: MobileSettings[K]) => void;
type Update = (update: (d: MobileSettings) => MobileSettings) => void;
type Option = { value: string; label: string };
export type SettingsPage = 'transcription' | 'keyboard' | 'agent';

const LAN = "On this iPhone, localhost is the phone itself. Use your computer's LAN IP.";
const USAGE_URL = 'https://chatgpt.com/settings/usage';

/** Native SwiftUI settings: one draft shared by every drill-down page, committed by Save. */
export function SettingsScreen({ app, initialPage, onClose }: { app: App; initialPage?: SettingsPage; onClose: () => void }) {
  const [draft, setDraft] = useState(app.settings);
  const [saving, setSaving] = useState(false);
  const [path, setPath] = useState<string[]>(initialPage ? [initialPage] : []);
  const set: Set = (key, value) => setDraft(d => ({ ...d, [key]: value }));
  const setServer = (id: string, patch: Partial<MCPServerSettings>) =>
    setDraft(d => ({ ...d, mcpServers: d.mcpServers.map(s => (s.id === id ? { ...s, ...patch } : s)) }));
  const canSave = app.phase === 'idle' && !saving;

  const save = async () => {
    setSaving(true);
    try {
      await app.saveSettings(draft);
      onClose();
    } catch (e) {
      Alert.alert('Not saved', settingsError(e));
    } finally {
      setSaving(false);
    }
  };

  // Cancel never drops typed credentials or endpoints without asking.
  const cancel = () => {
    if (JSON.stringify(draft) === JSON.stringify(app.settings)) return onClose();
    Alert.alert('Discard changes?', 'Your unsaved settings changes will be lost.', [
      { text: 'Keep Editing', style: 'cancel' },
      { text: 'Discard Changes', style: 'destructive', onPress: onClose },
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

  const addServer = () => {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    set('mcpServers', [...draft.mcpServers, { id, name: '', endpoint: '', token: '', enabled: true }]);
    setPath(p => [...p, `mcp:${id}`]);
  };
  const removeServer = (server: MCPServerSettings) =>
    Alert.alert(`Remove ${server.name || 'this server'}?`, 'Its tools and approval policies are removed when you save.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => {
        setPath(p => p.filter(page => !page.endsWith(server.id)));
        setDraft(d => ({ ...d, mcpServers: d.mcpServers.filter(s => s.id !== server.id) }));
      } },
    ]);

  const transcriptionSummary = draft.transcriptionSource === 'on-device'
    ? 'On this iPhone'
    : transcriptionProviders.find(p => p.value === draft.transcriptionProvider)?.label ?? '';

  return (
    <Host style={{ flex: 1, backgroundColor: color.page }} colorScheme="dark" useViewportSizeMeasurement>
      <NavigationStack path={path} onPathChange={setPath} modifiers={[tint(color.blue)]}>
        <Toolbar>
          <Form modifiers={[navigationTitle('Settings')]}>
            <Section>
              <Nav value="transcription" title="Transcription" icon="waveform" detail={transcriptionSummary} />
              <Nav value="keyboard" title="Keyboard" icon="keyboard" />
            </Section>
            <Section footer={<Text>One spoken command, one run. No chat history.</Text>}>
              <Nav value="agent" title="Agent Mode" icon="sparkles" detail={draft.agentEnabled ? 'On' : 'Off'} />
            </Section>
            {draft.agentEnabled ? (
              <Section title="MCP servers" footer={<Text>{`HTTP servers only. ${LAN}`}</Text>}>
                {draft.mcpServers.map(server => (
                  <Nav key={server.id} value={`mcp:${server.id}`} title={server.name || 'Untitled server'} icon="server.rack" detail={server.enabled ? 'On' : 'Off'} />
                ))}
                <Button label="Add Server" systemImage="plus" onPress={addServer} modifiers={[disabled(draft.mcpServers.length >= 10)]} />
              </Section>
            ) : null}
            <Section
              title="Network"
              footer={<Text>{draft.allowInsecureHTTP ? 'Audio, keys, and tokens can be read by anyone on your network.' : 'Needed for http:// endpoints on your LAN.'}</Text>}
            >
              <Toggle label="Allow Unencrypted HTTP" isOn={draft.allowInsecureHTTP} onIsOnChange={toggleInsecure} />
            </Section>
          </Form>
          <Toolbar.Content>
            <ToolbarItem placement="cancellationAction">
              <Button label="Cancel" onPress={cancel} modifiers={[disabled(saving)]} />
            </ToolbarItem>
            <ToolbarItem placement="confirmationAction">
              <Button label={saving ? 'Saving…' : 'Save'} onPress={() => { void save(); }} modifiers={[disabled(!canSave)]} />
            </ToolbarItem>
          </Toolbar.Content>
        </Toolbar>

        <NavigationDestination value="transcription">
          <Page title="Transcription">
            <Section footer={<Text>Used by Dictation and Agent Mode.</Text>}>
              <Picker
                label="Source"
                selection={draft.transcriptionSource}
                onSelectionChange={v => set('transcriptionSource', v as MobileSettings['transcriptionSource'])}
                modifiers={[pickerStyle('segmented')]}
              >
                <Text modifiers={[tag('endpoint')]}>Endpoint</Text>
                <Text modifiers={[tag('on-device')]}>On this iPhone</Text>
              </Picker>
            </Section>
            {draft.transcriptionSource === 'on-device'
              ? <OnDevice draft={draft} set={set} app={app} />
              : <RemoteTranscription draft={draft} set={set} setDraft={setDraft} />}
          </Page>
        </NavigationDestination>

        <NavigationDestination value="keyboard">
          <Page title="Keyboard">
            <Section footer={<Text>Password fields and some apps always use the system keyboard.</Text>}>
              <Text>Dictate into any app with the Shuddhalekhan keyboard.</Text>
              <Step n={1} text="In iOS Settings, open General › Keyboard › Keyboards › Add New Keyboard, then choose Shuddhalekhan." />
              <Step n={2} text="Tap Shuddhalekhan and turn on Allow Full Access. It only passes start, stop, and finished text between the keyboard and this app." />
              <Step n={3} text="Start a keyboard session on the home screen. In any app, switch keyboards with the globe key, tap Dictate, speak, then tap Stop." />
            </Section>
            <Section footer={<Text>iOS keyboards can't use the microphone, so this app records during the session. The keyboard always transcribes on this iPhone with Parakeet.</Text>}>
              <Link label="Open iOS Settings" destination="app-settings:" />
            </Section>
          </Page>
        </NavigationDestination>

        <NavigationDestination value="agent">
          <Page title="Agent Mode">
            <Section footer={<Text>Speak a command with the red Agent mode. Tools can ask for approval before they run.</Text>}>
              <Toggle label="Agent Mode" isOn={draft.agentEnabled} onIsOnChange={v => set('agentEnabled', v)} />
            </Section>
            {draft.agentEnabled ? <AgentProvider draft={draft} set={set} setDraft={setDraft} app={app} /> : null}
            {draft.agentEnabled ? (
              <Section
                title="Custom instructions"
                footer={<Text>{`Added to Shuddhalekhan's built-in instructions. ${draft.customInstructions.length}/4000`}</Text>}
              >
                <Field
                  label="Custom instructions"
                  placeholder="e.g. Answer in one short paragraph."
                  value={draft.customInstructions}
                  onChange={v => set('customInstructions', v)}
                  multiline
                  prose
                  maxLength={4000}
                />
              </Section>
            ) : null}
          </Page>
        </NavigationDestination>

        {draft.mcpServers.map(server => (
          <NavigationDestination key={server.id} value={`mcp:${server.id}`}>
            <Page title={server.name || 'MCP server'}>
              <Section>
                <Toggle label="Enabled" isOn={server.enabled} onIsOnChange={enabled => setServer(server.id, { enabled })} />
                <Field label="Name" value={server.name} onChange={name => setServer(server.id, { name })} prose />
              </Section>
              <Section footer={<Text>Changing the endpoint or token resets this server's tool policies.</Text>}>
                <Field label="Endpoint" placeholder="http://192.168.1.20:3000/mcp" url value={server.endpoint}
                  onChange={endpoint => setServer(server.id, { endpoint, toolPolicies: {} })} />
                <Field label="Bearer token" placeholder="Optional" secret value={server.token}
                  onChange={token => setServer(server.id, { token, toolPolicies: {} })} />
              </Section>
              <Section footer={<Text>New tools ask every time.</Text>}>
                <Nav value={`tools:${server.id}`} title="Tool Approval" detail={policySummary(server)} />
              </Section>
              <Section>
                <Button label="Remove Server" role="destructive" onPress={() => removeServer(server)} />
              </Section>
            </Page>
          </NavigationDestination>
        ))}
        {draft.mcpServers.map(server => (
          <NavigationDestination key={`tools:${server.id}`} value={`tools:${server.id}`}>
            <MCPToolPolicies server={server} allowHTTP={draft.allowInsecureHTTP} onChange={toolPolicies => setServer(server.id, { toolPolicies })} />
          </NavigationDestination>
        ))}
      </NavigationStack>
    </Host>
  );
}

const policySummary = (server: MCPServerSettings) => {
  const count = Object.keys(server.toolPolicies ?? {}).length;
  return count ? `${count} custom` : 'Ask Every Time';
};

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return <Form modifiers={[navigationTitle(title), scrollDismissesKeyboard('interactively')]}>{children}</Form>;
}

function Nav({ value, title, icon, detail }: { value: string; title: string; icon?: Parameters<typeof Label>[0]['systemImage']; detail?: string }) {
  return (
    <NavigationLink value={value}>
      <LabeledContent label={icon ? <Label title={title} systemImage={icon} /> : <Text>{title}</Text>}>
        <Text>{detail ?? ''}</Text>
      </LabeledContent>
    </NavigationLink>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return <Label title={text} systemImage={`${n}.circle.fill` as Parameters<typeof Label>[0]['systemImage']} />;
}

function Choice({ label, value, options, onChange, long }: { label: string; value: string; options: Option[]; onChange: (v: string) => void; long?: boolean }) {
  // A saved value missing from the list (e.g. a typed language code) stays visible and selected.
  const list = options.some(o => o.value === value) ? options : [{ value, label: value }, ...options];
  return (
    <Picker label={label} selection={value} onSelectionChange={v => onChange(String(v))} modifiers={[pickerStyle(long ? 'navigationLink' : 'menu')]}>
      {list.map(o => <Text key={o.value} modifiers={[tag(o.value)]}>{o.label}</Text>)}
    </Picker>
  );
}

// Native text state follows the draft, so provider switches that clear a key also clear the field.
function Field({ label, value, onChange, placeholder, secret, url, multiline, prose, maxLength }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
  secret?: boolean; url?: boolean; multiline?: boolean; prose?: boolean; maxLength?: number;
}) {
  const text = useNativeState(value);
  useEffect(() => { if (text.get() !== value) text.set(value); }, [text, value]);
  const input = [
    ...(prose ? [] : [autocorrectionDisabled(), textInputAutocapitalization('never')]),
    ...(url ? [keyboardType('url'), textContentType('URL')] : []),
  ];
  if (multiline) {
    return <TextField text={text} placeholder={placeholder ?? label} axis="vertical" maxLength={maxLength} onTextChange={onChange}
      modifiers={[...input, lineLimit({ min: 3, max: 10 })]} />;
  }
  const Input = secret ? SecureField : TextField;
  return (
    <LabeledContent label={label}>
      <Input text={text} placeholder={placeholder ?? 'Required'} maxLength={maxLength} onTextChange={onChange}
        modifiers={[...input, multilineTextAlignment('trailing')]} />
    </LabeledContent>
  );
}

const localLanguages = [{ value: '', label: 'Auto-detect' }, ...parakeetLanguages];
const remoteLanguages = [{ value: '', label: 'Auto-detect' }, ...speechLanguages];
const sarvamModes: Record<(typeof SARVAM_MODES)[number], string> = {
  transcribe: 'Transcribe', verbatim: 'Verbatim', translit: 'Transliterate', codemix: 'Code-mixed',
};
const transcriptionAuth = [{ value: 'none', label: 'None' }, { value: 'bearer', label: 'Bearer token' }, { value: 'header', label: 'Custom header' }];
const agentAuth = [{ value: 'none', label: 'None' }, { value: 'bearer', label: 'Bearer token' }, { value: 'api-key', label: 'api-key header' }];
const reasoning = ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ value, label: value === 'default' ? 'Provider default' : value }));

// Per-provider fields: only what the selected provider's request uses.
function RemoteTranscription({ draft, set, setDraft }: { draft: MobileSettings; set: Set; setDraft: Update }) {
  const provider = draft.transcriptionProvider;
  const preset = transcriptionProviders.find(p => p.value === provider);
  const keyed = provider === 'openai' || provider === 'sarvam' || provider === 'azure-speech';
  const auth = provider === 'custom-open-ai-compatible' || provider === 'nvidia-speech-nim' ? transcriptionAuth
    : provider === 'whisper-live-kit' ? transcriptionAuth.slice(0, 2) : null;
  const usesDictionary = provider !== 'whisper-live-kit' && (provider !== 'nvidia-speech-nim' || draft.nimDictionary);
  return (
    <>
      <Section footer={<Text>{preset?.placeholder && provider !== 'azure-speech' ? `Full URL including the path. ${LAN}` : 'Switching provider clears its saved credentials.'}</Text>}>
        <Choice label="Provider" value={provider} options={transcriptionProviders}
          onChange={v => setDraft(d => selectTranscriptionProvider(d, v as MobileSettings['transcriptionProvider']))} />
        {preset?.placeholder ? (
          <Field label={provider === 'azure-speech' ? 'Resource' : 'Endpoint'} url value={draft.transcriptionEndpoint}
            onChange={v => set('transcriptionEndpoint', v)} placeholder={provider === 'azure-speech' ? 'Optional' : preset.placeholder} />
        ) : null}
        {provider === 'azure-speech' ? <Field label="Region" value={draft.azureRegion} onChange={v => set('azureRegion', v)} placeholder="centralindia" /> : null}
        {provider === 'google-cloud-speech-v2' ? (
          <>
            <Field label="Project ID" value={draft.googleProject} onChange={v => set('googleProject', v)} />
            <Field label="Location" value={draft.googleLocation} onChange={v => set('googleLocation', v)} placeholder="global" />
          </>
        ) : null}
        {provider === 'sarvam' ? (
          <>
            <Choice label="Model" value={draft.transcriptionModel} options={SARVAM_MODELS.map(value => ({ value, label: value }))} onChange={v => set('transcriptionModel', v)} />
            <Choice label="Mode" value={draft.sarvamMode} options={SARVAM_MODES.map(value => ({ value, label: sarvamModes[value] }))}
              onChange={v => set('sarvamMode', v as MobileSettings['sarvamMode'])} />
          </>
        ) : provider !== 'azure-speech' && provider !== 'local-whisper-cpp' ? (
          <Field label="Model" value={draft.transcriptionModel} onChange={v => set('transcriptionModel', v)} placeholder={preset?.model || 'Optional'} />
        ) : null}
        {auth ? <Choice label="Authentication" value={draft.transcriptionAuth} options={auth} onChange={v => set('transcriptionAuth', v as MobileSettings['transcriptionAuth'])} /> : null}
        {auth && draft.transcriptionAuth === 'header' ? <Field label="Header name" value={draft.transcriptionHeaderName} onChange={v => set('transcriptionHeaderName', v)} /> : null}
        {keyed || (auth && draft.transcriptionAuth !== 'none') ? <Field label="API key" secret value={draft.transcriptionKey} onChange={v => set('transcriptionKey', v)} /> : null}
      </Section>
      {provider === 'google-cloud-speech-v2' ? (
        <Section title="Service account JSON" footer={<Text>Stored in the iOS Keychain. Its private key signs the token request on this iPhone and is never sent.</Text>}>
          <Field label="Service account JSON" value={draft.googleServiceAccount} onChange={v => set('googleServiceAccount', v)} multiline />
        </Section>
      ) : null}
      <Section footer={<Text>Regional variants help Azure, Google, and NVIDIA. Others receive the base language.</Text>}>
        <Choice label="Language" long value={draft.language} options={provider === 'google-cloud-speech-v2' ? speechLanguages : remoteLanguages} onChange={v => set('language', v)} />
        {provider === 'nvidia-speech-nim' ? (
          <>
            <Toggle label="Automatic Language" isOn={draft.nimAutoLanguage} onIsOnChange={v => set('nimAutoLanguage', v)} />
            <Toggle label="Send Dictionary as Prompt" isOn={draft.nimDictionary} onIsOnChange={v => set('nimDictionary', v)} />
          </>
        ) : null}
      </Section>
      {usesDictionary ? (
        <Section title="Dictionary" footer={<Text>Names and terms to spell correctly.</Text>}>
          <Field label="Dictionary" placeholder="Shuddhalekhan, Parakeet, …" value={draft.dictionary} onChange={v => set('dictionary', v)} multiline prose />
        </Section>
      ) : null}
    </>
  );
}

function AgentProvider({ draft, set, setDraft, app }: { draft: MobileSettings; set: Set; setDraft: Update; app: App }) {
  const provider = draft.agentProvider;
  const native = provider === 'openai' || provider === 'azure-openai';
  if (provider === 'chatgpt') return <ChatGptProvider draft={draft} set={set} setDraft={setDraft} app={app} />;
  return (
    <>
      <Section footer={<Text>{provider === 'openai-compatible'
        ? `Full chat completions URL, e.g. LM Studio at http://<computer IP>:1234/v1/chat/completions. ${LAN}`
        : 'Switching provider clears its saved key.'}</Text>}>
        <Choice label="Provider" value={provider} options={agentProviders} onChange={v => setDraft(d => selectAgentProvider(d, v as MobileSettings['agentProvider']))} />
        {native ? (
          <Picker label="API" selection={draft.agentApiMode} onSelectionChange={v => setDraft(d => selectAgentApiMode(d, v as MobileSettings['agentApiMode']))} modifiers={[pickerStyle('menu')]}>
            <Text modifiers={[tag('responses')]}>Responses</Text>
            <Text modifiers={[tag('chat-completions')]}>Chat Completions</Text>
          </Picker>
        ) : null}
        <Field label="Endpoint" url value={draft.agentEndpoint} onChange={v => set('agentEndpoint', v)}
          placeholder={agentProviders.find(p => p.value === provider)?.placeholder || 'https://'} />
        <Field label={provider === 'azure-openai' ? 'Deployment' : 'Model'} value={draft.agentModel} onChange={v => set('agentModel', v)} />
        {provider === 'azure-openai' || provider === 'openai-compatible' ? (
          <Choice label="Authentication" value={draft.agentAuth} options={provider === 'azure-openai' ? agentAuth.slice(1) : agentAuth}
            onChange={v => set('agentAuth', v as MobileSettings['agentAuth'])} />
        ) : null}
        {draft.agentAuth !== 'none' ? (
          <Field label="API key" secret value={draft.agentKey} onChange={v => set('agentKey', v)} placeholder={provider === 'openai-compatible' ? 'Optional' : undefined} />
        ) : null}
      </Section>
      <Section footer={<Text>A model that rejects the chosen effort fails the run.</Text>}>
        <Choice label="Reasoning" value={draft.agentReasoning} options={reasoning} onChange={v => set('agentReasoning', v as MobileSettings['agentReasoning'])} />
        {native ? <Toggle label="Prompt Caching" isOn={draft.agentCache} onIsOnChange={v => set('agentCache', v)} /> : null}
      </Section>
    </>
  );
}

// The account lives outside the draft: sign-in and sign-out apply immediately; only the model and effort wait for Save.
function ChatGptProvider({ draft, set, setDraft, app }: { draft: MobileSettings; set: Set; setDraft: Update; app: App }) {
  const { chatgpt } = app;
  const [models, setModels] = useState<ChatGptModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const signedIn = chatgpt.status === 'signed-in';
  useEffect(() => {
    if (!signedIn) return setModels(null);
    let live = true;
    setModelsError(null);
    app.listChatGptModels().then(list => { if (live) setModels(list); }, e => { if (live) setModelsError(settingsError(e)); });
    return () => { live = false; };
  }, [signedIn, app.listChatGptModels]);

  const signOut = () => Alert.alert('Sign out of ChatGPT?', 'Agent Mode stops working until you sign in again.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Sign Out', style: 'destructive', onPress: () => { void app.signOutChatGpt(); } },
  ]);

  const accountFooter = chatgpt.error ?? (signedIn && !chatgpt.planUsage
    ? 'This sign-in did not grant plan usage. Sign out, then sign in again and allow it.'
    : 'Runs use your ChatGPT plan instead of an API key.');
  return (
    <>
      <Section footer={<Text modifiers={chatgpt.error ? [foregroundStyle(color.red)] : undefined}>{accountFooter}</Text>}>
        <Choice label="Provider" value={draft.agentProvider} options={agentProviders} onChange={v => setDraft(d => selectAgentProvider(d, v as MobileSettings['agentProvider']))} />
        {chatgpt.status === 'loading' ? <ProgressView /> : null}
        {chatgpt.status === 'signed-out' || chatgpt.status === 'signing-in' ? (
          <Button label={chatgpt.status === 'signing-in' ? 'Signing In…' : 'Continue with ChatGPT'} onPress={() => { void app.signInChatGpt(); }}
            modifiers={[disabled(chatgpt.status === 'signing-in')]} />
        ) : null}
        {signedIn ? (
          <>
            <LabeledContent label="Account"><Text>{chatgpt.email ?? 'Signed in'}</Text></LabeledContent>
            <Link label="Manage Usage" destination={USAGE_URL} />
            <Button label="Sign Out" role="destructive" onPress={signOut} />
          </>
        ) : null}
      </Section>
      {signedIn ? (
        <Section footer={modelsError ? <Text modifiers={[foregroundStyle(color.red)]}>{modelsError}</Text> : <Text>A model that rejects the chosen effort fails the run.</Text>}>
          {models?.length
            ? <Choice label="Model" value={draft.agentModel} options={models.map(m => ({ value: m.id, label: m.label }))} onChange={v => set('agentModel', v)} />
            : models || modelsError
              ? <Field label="Model" value={draft.agentModel} onChange={v => set('agentModel', v)} />
              : <LabeledContent label="Model"><ProgressView /></LabeledContent>}
          <Choice label="Reasoning" value={draft.agentReasoning} options={reasoning} onChange={v => set('agentReasoning', v as MobileSettings['agentReasoning'])} />
        </Section>
      ) : null}
    </>
  );
}

// Status and install action for the Parakeet model the selected language uses. Install runs outside the Settings draft.
function OnDevice({ draft, set, app }: { draft: MobileSettings; set: Set; app: App }) {
  const english = localModelKey(draft.language) === 'english';
  const model: LocalModelState = app.localModels[english ? 'english' : 'multilingual'];
  const name = english ? 'Parakeet v2 (English)' : 'Parakeet v3 (multilingual)';
  const preparing = app.preparingModel;
  const confirmInstall = () =>
    Alert.alert(
      'Download about 0.5 GB?',
      `Shuddhalekhan downloads ${name} and installs it in the app. Use Wi-Fi; cellular data charges may apply. iOS then prepares the model, which can take a few minutes the first time.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Download', onPress: () => { void app.installLocalModel(normalizeLanguage(draft.language)); } },
      ],
    );
  const languages = 'Parakeet supports 25 European languages, not Hindi or Marathi; use an endpoint for those.';
  const footer = model.kind === 'unavailable' ? 'Install the updated app to use on-device Parakeet. It requires iOS 17 or later.'
    : model.kind === 'downloading' ? 'Keep Shuddhalekhan open until the download finishes.'
      : model.kind === 'installing' ? 'The first time can take a few minutes.'
        : model.kind === 'ready' ? `Agent Mode still sends the transcript to your agent provider. ${languages}`
          : model.kind === 'error' ? model.message
            : preparing ? 'Wait for the installed model to finish preparing.'
              : `One-time download of about 0.5 GB. ${languages}`;

  return (
    <Section footer={<Text modifiers={model.kind === 'error' ? [foregroundStyle(color.red)] : undefined}>{footer}</Text>}>
      <Choice label="Language" long value={draft.language} options={localLanguages} onChange={v => set('language', v)} />
      <LabeledContent label="Model">
        <Text>{model.kind === 'ready' ? 'Installed' : model.kind === 'checking' ? 'Checking…' : model.kind === 'unavailable' ? 'Unavailable' : name}</Text>
      </LabeledContent>
      {model.kind === 'downloading' || model.kind === 'installing' ? (
        <ProgressView value={model.kind === 'downloading' ? model.fraction : null}>
          <Text>{model.kind === 'downloading' ? `Downloading… ${Math.round(model.fraction * 100)}%` : 'Preparing for this iPhone…'}</Text>
        </ProgressView>
      ) : null}
      {model.kind === 'missing' || model.kind === 'error' ? (
        <Button label={model.kind === 'error' ? 'Retry Download' : 'Download Model'} systemImage="arrow.down.circle" onPress={confirmInstall} modifiers={[disabled(preparing)]} />
      ) : null}
    </Section>
  );
}
