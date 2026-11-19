import { useState } from 'react';
import { Alert } from 'react-native';
import {
  Button, Label, LabeledContent, Link, NavigationLink, Picker, Section, Text, TextField, Toggle, VStack, useNativeState,
} from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, autocorrectionDisabled, disabled, font, foregroundStyle, pickerStyle, submitLabel, tag, textInputAutocapitalization,
} from '@expo/ui/swift-ui/modifiers';
import type { DictationPreferences, DictationStyle, SessionMinutes } from '../dictation-preferences';
import { isParakeetLanguage, languageLabel } from '../languages';
import { agentCredentialsReady } from '../providers';
import type { useMobileApp } from '../useMobileApp';
import { color } from './kit';
import type { useDictation } from './useDictation';

type App = ReturnType<typeof useMobileApp>;
type Dictation = ReturnType<typeof useDictation>;
type Update = Dictation['update'];
type SFSymbol = Parameters<typeof Label>[0]['systemImage'];

const dictationStyles = [
  { value: 'polished', label: 'Polished', description: 'Removes filler like “um”, capitalizes sentences, and adds punctuation.' },
  { value: 'casual', label: 'Casual', description: 'Relaxed casing, and no forced period at the end. Good for messages.' },
  { value: 'notes', label: 'Notes', description: 'Say “new line”, “new paragraph”, or “bullet” to format as you speak.' },
  { value: 'verbatim', label: 'Verbatim', description: 'Keeps exactly what the recognizer heard, with minimal changes.' },
] satisfies { value: Exclude<DictationStyle, 'legacy'>; label: string; description: string }[];

/** Upgraded installs keep their pre-style output ('legacy') until they pick a style. */
const styleLabel = (style: DictationStyle) => dictationStyles.find(s => s.value === style)?.label ?? 'Original';

const sessionPresets = [5, 10, 15, 30] satisfies SessionMinutes[];

// UI-side checks for friendly messages; updateDictationPreferences stays the authority.
// ponytail: limits mirror dictation-preferences.ts; import them from there if it exports them.
const VOCABULARY_MAX = 100;
const TERM_MAX = 64;
const cleanTerm = (term: string) => term.trim().replace(/\s+/g, ' ');
const termKey = (term: string) => cleanTerm(term).normalize('NFKC').toLocaleLowerCase();

/** Why a term can't be saved, or null. `others` excludes the term being edited. */
function vocabularyProblem(term: string, others: string[]): string | null {
  const clean = cleanTerm(term);
  if (!/[\p{L}\p{N}]/u.test(clean)) return 'Enter a word or phrase.';
  if (clean.length > TERM_MAX) return `Keep each term to ${TERM_MAX} characters or fewer.`;
  if (others.some(other => termKey(other) === termKey(clean))) return `“${clean}” is already in your vocabulary.`;
  return null;
}

// --- Transcription page: what happens to Dictation text after speech recognition ---

export function DictationOutput({ dictation }: { dictation: Dictation }) {
  const { preferences, readiness, update } = dictation;
  if (!preferences) return null;
  const cleanupAvailable = readiness?.cleanup === 'available';
  const cleanupFooter = !readiness ? 'Checking Apple Intelligence…'
    : cleanupAvailable ? 'Fixes obvious misrecognitions on this iPhone, with nothing sent anywhere. If it is slow or changes numbers, names, or meaning, you get the original text.'
      : `Unavailable${readiness.cleanupReason ? `: ${readiness.cleanupReason.replace(/\.?$/, '.')}` : '.'} Needs iOS 26 or later on an iPhone that supports Apple Intelligence, with it turned on and its model downloaded, in a supported language.`;
  return (
    <>
      <Section title="Dictation text" footer={<Text>Applies to Dictation in the app and the keyboard. Agent commands are never changed.</Text>}>
        <NavigationLink value="style">
          <LabeledContent label={<Label title="Style" systemImage="textformat" />}><Text>{styleLabel(preferences.style)}</Text></LabeledContent>
        </NavigationLink>
        <NavigationLink value="vocabulary">
          <LabeledContent label={<Label title="Vocabulary" systemImage="character.book.closed" />}>
            <Text>{preferences.vocabularyEnabled ? `${preferences.vocabulary.length} terms` : 'Off'}</Text>
          </LabeledContent>
        </NavigationLink>
      </Section>
      <Section footer={<Text>{cleanupFooter}</Text>}>
        <Toggle
          label="Clean Up with Apple Intelligence"
          isOn={preferences.cleanupEnabled}
          onIsOnChange={cleanupEnabled => { void update({ cleanupEnabled }); }}
          // Always switchable off, even if Apple Intelligence went away after it was turned on.
          modifiers={[disabled(!cleanupAvailable && !preferences.cleanupEnabled)]}
        />
      </Section>
    </>
  );
}

export function StylePicker({ preferences, update }: { preferences: DictationPreferences; update: Update }) {
  const footer = preferences.style === 'legacy'
    ? 'You are using the original formatting from before styles. Choose one to change how new dictation looks; past results stay as they are.'
    : 'Applies to your next dictation. You can also change it from the keyboard.';
  return (
    <Section footer={<Text>{footer}</Text>}>
      <Picker
        label="Style"
        selection={preferences.style}
        onSelectionChange={value => {
          const style = dictationStyles.find(s => s.value === value)?.value;
          if (style) void update({ style });
        }}
        modifiers={[pickerStyle('inline')]}
      >
        {dictationStyles.map(style => (
          <VStack key={style.value} alignment="leading" spacing={2} modifiers={[tag(style.value)]}>
            <Text>{style.label}</Text>
            <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(color.muted)]}>{style.description}</Text>
          </VStack>
        ))}
      </Picker>
    </Section>
  );
}

export function VocabularyEditor({ preferences, update }: { preferences: DictationPreferences; update: Update }) {
  const terms = preferences.vocabulary;
  const [query, setQuery] = useState('');
  const search = useNativeState('');
  const shown = query.trim() ? terms.filter(term => termKey(term).includes(termKey(query))) : terms;
  const full = terms.length >= VOCABULARY_MAX;

  // Alert.prompt keeps add and edit in one native, VoiceOver-friendly dialog.
  const save = async (value: string | undefined, index: number | null) => {
    const others = index === null ? terms : terms.filter((_, i) => i !== index);
    const problem = vocabularyProblem(value ?? '', others);
    if (problem) return Alert.alert('Not saved', problem);
    const term = cleanTerm(value ?? '');
    await update({ vocabulary: index === null ? [...terms, term] : terms.map((t, i) => (i === index ? term : t)) });
  };
  const add = () => Alert.prompt('Add Term', 'A name or word, spelled the way you want it.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Add', isPreferred: true, onPress: value => { void save(value, null); } },
  ], 'plain-text');
  const edit = (term: string) => {
    const index = terms.indexOf(term);
    Alert.prompt('Edit Term', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => { void update({ vocabulary: terms.filter((_, i) => i !== index) }); } },
      { text: 'Save', isPreferred: true, onPress: value => { void save(value, index); } },
    ], 'plain-text', term);
  };

  return (
    <>
      <Section footer={<Text>Fixes the spelling of names and terms after transcription, on this iPhone. Never sent to a provider, and it doesn't change what the recognizer hears.</Text>}>
        <Toggle label="Use Vocabulary" isOn={preferences.vocabularyEnabled} onIsOnChange={vocabularyEnabled => { void update({ vocabularyEnabled }); }} />
      </Section>
      <Section
        title={`Terms · ${terms.length}/${VOCABULARY_MAX}`}
        footer={<Text>{!preferences.vocabularyEnabled ? 'Off: dictation is left as recognized. Your terms are kept.'
          : full ? `That's the limit of ${VOCABULARY_MAX}. Remove a term to add another.` : `Up to ${TERM_MAX} characters each. Tap a term to edit or remove it.`}</Text>}
      >
        {terms.length > 0 ? (
          <TextField
            text={search}
            placeholder="Search"
            onTextChange={setQuery}
            modifiers={[autocorrectionDisabled(), textInputAutocapitalization('never'), submitLabel('search'), accessibilityAddTraits(['isSearchField'])]}
          />
        ) : null}
        {shown.map(term => <Button key={term} label={term} onPress={() => edit(term)} />)}
        {terms.length > 0 && shown.length === 0 ? <Text modifiers={[foregroundStyle(color.muted)]}>No matching terms</Text> : null}
        <Button label="Add Term" systemImage="plus" onPress={add} modifiers={[disabled(full)]} />
      </Section>
    </>
  );
}

// --- Keyboard page: live checklist, session length, guided test ---

type Check = { title: string; icon: SFSymbol; status: string; state: 'ok' | 'unknown' | 'problem' };
const checkStyle = {
  ok: { icon: 'checkmark.circle.fill', tint: color.green },
  unknown: { icon: 'questionmark.circle', tint: color.ochre },
  problem: { icon: 'exclamationmark.circle.fill', tint: color.red },
} satisfies Record<Check['state'], { icon: SFSymbol; tint: string }>;

function CheckRow({ check }: { check: Check }) {
  const look = checkStyle[check.state];
  return (
    <LabeledContent label={<Label title={check.title} systemImage={check.icon} />}>
      <Label title={check.status} systemImage={look.icon} modifiers={[foregroundStyle(look.tint)]} />
    </LabeledContent>
  );
}

function modelCheck(app: App): Check {
  const base = { title: 'Speech model', icon: 'cpu' } as const;
  if (!isParakeetLanguage(app.settings.language)) return { ...base, status: `No ${languageLabel(app.settings.language)}`, state: 'problem' };
  const model = app.localModel;
  if (app.preparingModel && model.kind !== 'ready') return { ...base, status: 'Preparing…', state: 'unknown' };
  switch (model.kind) {
    case 'ready': return { ...base, status: 'Installed', state: 'ok' };
    case 'checking': return { ...base, status: 'Checking…', state: 'unknown' };
    case 'downloading': return { ...base, status: `Downloading ${Math.round(model.fraction * 100)}%`, state: 'unknown' };
    case 'installing': return { ...base, status: 'Preparing…', state: 'unknown' };
    case 'missing': return { ...base, status: 'Not downloaded', state: 'problem' };
    case 'error': return { ...base, status: 'Failed', state: 'problem' };
    case 'unavailable': return { ...base, status: 'Unavailable', state: 'problem' };
  }
}

const verified = (value: 'verified' | 'unverified') => value === 'verified'
  ? { status: 'Verified', state: 'ok' } as const
  : { status: 'Not verified', state: 'unknown' } as const;

export function KeyboardSetup({ app, dictation, onInstallModel }: { app: App; dictation: Dictation; onInstallModel: () => void }) {
  const { preferences, readiness, update, requestMicrophone } = dictation;
  const session = app.keyboardSession;
  const model = modelCheck(app);
  const microphone = readiness?.microphone;
  const chatgpt = app.chatgpt.status === 'signed-in' && app.chatgpt.planUsage;
  const agentReady = app.settings.agentProvider === 'chatgpt' ? chatgpt : agentCredentialsReady(app.settings);
  const checks: Check[] = [
    { title: 'Keyboard added', icon: 'keyboard', ...(readiness ? verified(readiness.keyboard) : { status: 'Checking…', state: 'unknown' }) },
    { title: 'Full Access', icon: 'lock.open', ...(readiness ? verified(readiness.fullAccess) : { status: 'Checking…', state: 'unknown' }) },
    {
      title: 'Microphone', icon: 'mic',
      ...(microphone === 'granted' ? { status: 'Allowed', state: 'ok' } : microphone === 'denied' ? { status: 'Denied', state: 'problem' }
        : microphone === 'undetermined' ? { status: 'Not asked yet', state: 'problem' } : { status: 'Checking…', state: 'unknown' }),
    },
    model,
    // Agent Mode is optional; only shown when the user turned it on.
    ...(app.settings.agentEnabled ? [{ title: 'Agent', icon: 'sparkles', ...(agentReady ? { status: 'Ready', state: 'ok' } : { status: 'Needs setup', state: 'problem' }) } satisfies Check] : []),
  ];
  const canInstall = model.state === 'problem' && (app.localModel.kind === 'missing' || app.localModel.kind === 'error') && isParakeetLanguage(app.settings.language);
  const canStart = model.state === 'ok' && app.phase === 'idle' && !session.starting;
  const m = Math.floor(session.remainingSeconds / 60);
  const s = String(session.remainingSeconds % 60).padStart(2, '0');
  const trouble = session.endedReason ? `Last session ended: ${session.endedReason.replace(/\.?$/, '.')} Start a new one to keep dictating.`
    : model.state !== 'ok' ? 'The keyboard transcribes on this iPhone, so download the speech model first.'
      : microphone === 'denied' ? 'Allow the microphone in iOS Settings, then come back.'
        : 'If the keyboard says no session is running, it won\'t bring you back here: open Shuddhalekhan yourself and start one. If tapping Dictate does nothing, check that Allow Full Access is on.';

  return (
    <>
      <Section
        title="Setup"
        footer={<Text>iOS doesn't tell apps whether a keyboard is added or has Full Access. They show Verified for a few seconds after the keyboard checks in with a running session. Full Access only lets the keyboard pass start, stop, and finished text to this app.</Text>}
      >
        {checks.map(check => <CheckRow key={check.title} check={check} />)}
        {microphone === 'undetermined' ? <Button label="Allow Microphone" systemImage="mic" onPress={() => { void requestMicrophone(); }} /> : null}
        {canInstall ? <Button label={app.localModel.kind === 'error' ? 'Retry Model Download' : 'Download Speech Model'} systemImage="arrow.down.circle" onPress={onInstallModel} modifiers={[disabled(app.preparingModel)]} /> : null}
        {app.settings.agentEnabled && !agentReady ? <NavigationLink value="agent"><Text>Set Up Agent Mode</Text></NavigationLink> : null}
        <Link label="Open iOS Settings" destination="app-settings:" />
      </Section>
      <Section footer={<Text>In iOS Settings, tap Keyboards, then turn on Shuddhalekhan and Allow Full Access. Or add it from General › Keyboard › Keyboards › Add New Keyboard.</Text>}>
        <Text>Dictate into any app with the Shuddhalekhan keyboard. Password fields and some apps always use the system keyboard.</Text>
      </Section>

      {preferences ? (
        <Section footer={<Text>Applies to the next keyboard session. iOS keyboards can't use the microphone, so this app records for them while a session is on.</Text>}>
          <Picker
            label="Session Length"
            selection={preferences.sessionMinutes}
            onSelectionChange={value => {
              const sessionMinutes = sessionPresets.find(preset => preset === value);
              if (sessionMinutes) void update({ sessionMinutes });
            }}
            modifiers={[pickerStyle('menu')]}
          >
            {sessionPresets.map(minutes => <Text key={minutes} modifiers={[tag(minutes)]}>{`${minutes} minutes`}</Text>)}
          </Picker>
        </Section>
      ) : null}

      <Section title="Test dictation" footer={<Text>{trouble}</Text>}>
        <Label title="Start a keyboard session below." systemImage="1.circle.fill" />
        <Label title="Open Notes and tap where you want text." systemImage="2.circle.fill" />
        <Label title="Hold the globe key and choose Shuddhalekhan." systemImage="3.circle.fill" />
        <Label title="Tap Dictate, speak, then tap Stop. The text appears once at the cursor." systemImage="4.circle.fill" />
        {session.active ? (
          <>
            <LabeledContent label="Session on"><Text>{session.remainingSeconds === 0 && session.busy ? 'Finishing…' : `${m}:${s} left`}</Text></LabeledContent>
            <Button label="Stop Session" role="destructive" onPress={() => { void app.stopKeyboardSession(); }} />
          </>
        ) : (
          <Button
            label={session.starting ? 'Starting…' : 'Start Keyboard Session'}
            systemImage="keyboard"
            onPress={() => { app.startKeyboardSession().catch((e: unknown) => Alert.alert('Keyboard session', e instanceof Error ? e.message : 'Could not start the session.')); }}
            modifiers={[disabled(!canStart)]}
          />
        )}
      </Section>
    </>
  );
}

// --- Shortcuts & Controls: help only; the system actions themselves are native ---

export function ShortcutsHelp() {
  return (
    <>
      <Section title="Shortcuts and Siri" footer={<Text>Agent Mode isn't available from Shortcuts yet. For Ask Agent, start a keyboard session from Home.</Text>}>
        <Label title="Dictate (Dictate with Shuddhalekhan): records, transcribes on this iPhone, and copies the text for you to paste." systemImage="waveform" />
        <Label title="Start Keyboard Session: opens Shuddhalekhan to start a Dictation-only keyboard session for your chosen length." systemImage="keyboard" />
        <Label title="Stop Keyboard Session: ends the running keyboard session." systemImage="keyboard.chevron.compact.down" />
        <Link label="Open Shortcuts" destination="shortcuts://" />
      </Section>
      <Section title="Action Button and Back Tap" footer={<Text>iOS doesn't let apps change these for you.</Text>}>
        <Label title="Action Button (iPhone 15 Pro and later): Settings › Action Button › Shortcut, then pick a Shuddhalekhan action." systemImage="button.horizontal.top.press" />
        <Label title="Back Tap: Settings › Accessibility › Touch › Back Tap, then pick a Shuddhalekhan action." systemImage="hand.tap" />
      </Section>
      <Section title="Control Center" footer={<Text>iOS 18 or later.</Text>}>
        <Label title="Open Control Center, tap +, then Add a Control and search for Shuddhalekhan." systemImage="switch.2" />
      </Section>
      <Section title="If iOS can't record in the background">
        <Text>Dictate shows a message asking you to open Shuddhalekhan and dictate there. This happens when the microphone isn't allowed, the speech model isn't ready, or iOS stops background recording.</Text>
        <Text>If the text can't be copied in the background, open Shuddhalekhan and copy the finished transcript from Home.</Text>
        <Text>Copied isn't pasted: tap where you want the text and paste it. Other apps can read the clipboard when iOS allows them.</Text>
      </Section>
    </>
  );
}
