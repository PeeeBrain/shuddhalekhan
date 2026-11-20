import { useContext, useEffect, useState, type ReactNode } from 'react';
import { Alert, Animated, Easing, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Host, ProgressView } from '@expo/ui/swift-ui';
import { tint } from '@expo/ui/swift-ui/modifiers';
import { isParakeetLanguage, normalizeLanguage } from '../languages';
import { transcriptionReady } from '../providers';
import type { useMobileApp } from '../useMobileApp';
import { Button, ReducedMotionContext, color, type } from './kit';
import type { SettingsPage } from './SettingsScreen';
import { useDictation } from './useDictation';

type App = ReturnType<typeof useMobileApp>;
type Step = 'welcome' | 'microphone' | 'model';

/**
 * First run, shown once while the microphone has never been asked for: what the app does, the microphone
 * prompt from an explicit tap, and an offer to download Parakeet when nothing can transcribe yet.
 * Every step can be skipped; Home and Settings cover anything left undone. `onDone` may name a Settings page to open.
 */
export function Onboarding({ app, onDone }: { app: App; onDone: (page?: SettingsPage) => void }) {
  const { readiness, requestMicrophone } = useDictation();
  const [step, setStep] = useState<Step>('welcome');
  const microphone = readiness?.microphone ?? 'undetermined';
  const { settings, localModel } = app;
  const configured = settings.transcriptionSource === 'on-device' ? localModel.kind === 'ready' : transcriptionReady(settings);
  // Only offer the download when it is the missing piece; an endpoint user or a model already on its way skips it.
  const offerModel = !configured && isParakeetLanguage(settings.language) && (localModel.kind === 'missing' || localModel.kind === 'error');
  const afterMicrophone = () => (offerModel ? setStep('model') : onDone());

  // Granting the prompt moves on by itself; a refusal stays to explain where the switch lives.
  useEffect(() => { if (step === 'microphone' && microphone === 'granted') afterMicrophone(); });

  const download = async () => {
    try {
      if (settings.transcriptionSource !== 'on-device') await app.saveSettings({ ...settings, transcriptionSource: 'on-device' });
      void app.installLocalModel(normalizeLanguage(settings.language));
    } catch (e) {
      Alert.alert('Download not started', e instanceof Error ? e.message : 'Try again from Settings.');
    }
  };

  return (
    <SafeAreaView style={s.screen}>
      <Reveal key={step}>
        {step === 'welcome' ? (
          <Page
            glyph={<View style={s.mic}><View style={s.micGlyph} /></View>}
            title="Speak anywhere you type."
            body="Dictate here or from the Shuddhalekhan keyboard in any app. Your words go to the speech service you choose, or stay on this iPhone."
          >
            <Button label="Continue" kind="primary" wide onPress={() => setStep('microphone')} />
          </Page>
        ) : step === 'microphone' ? (
          <Page
            glyph={<View style={s.mic}><View style={[s.micGlyph, microphone === 'denied' && { backgroundColor: color.muted }]} /></View>}
            title={microphone === 'denied' ? 'Microphone is off.' : 'Allow the microphone.'}
            body={microphone === 'denied'
              ? 'Turn on Microphone for Shuddhalekhan in iOS Settings. You can do this later too.'
              : 'Shuddhalekhan listens only while you record or keep a keyboard session open, and iOS shows the microphone indicator whenever it does.'}
          >
            {microphone === 'denied' ? (
              <>
                <Button label="Open iOS Settings" kind="primary" wide onPress={() => { void Linking.openSettings(); }} />
                <Button label="Not Now" kind="ghost" wide onPress={afterMicrophone} />
              </>
            ) : (
              // No skip before iOS asks: an unasked microphone is what brings this screen back.
              <Button label="Allow Microphone" kind="primary" wide onPress={() => { void requestMicrophone(); }} />
            )}
          </Page>
        ) : (
          <ModelStep app={app} onDownload={() => { void download(); }} onDone={onDone} />
        )}
      </Reveal>
    </SafeAreaView>
  );
}

function ModelStep({ app, onDownload, onDone }: { app: App; onDownload: () => void; onDone: (page?: SettingsPage) => void }) {
  const model = app.localModel;
  const busy = app.phase !== 'idle';
  const fraction = model.kind === 'downloading' || model.kind === 'installing' ? model.fraction : null;
  const detail = model.kind === 'downloading' ? `Downloading, ${Math.round(model.fraction * 100)}%. Keep Shuddhalekhan open until it finishes; you can continue now.`
    : model.kind === 'installing' ? 'Preparing the model for this iPhone. The first time can take a few minutes.'
      : model.kind === 'ready' ? 'Parakeet is ready. Dictation now works without a network.'
        : model.kind === 'error' ? model.message
          : 'Parakeet transcribes on this iPhone, so audio never leaves it. The download is about 0.5 GB; use Wi-Fi.';

  return (
    <Page
      glyph={<View style={s.mic}><View style={[s.micGlyph, { backgroundColor: model.kind === 'ready' ? color.green : color.blue }]} /></View>}
      title={model.kind === 'ready' ? 'Ready when you are.' : 'Transcribe on this iPhone.'}
      body={detail}
    >
      {fraction !== null ? (
        <Host matchContents={{ vertical: true }} colorScheme="dark">
          <ProgressView value={fraction} modifiers={[tint(color.blue)]} />
        </Host>
      ) : null}
      {model.kind === 'ready' ? <Button label="Start Dictating" kind="primary" wide onPress={() => onDone()} />
        : fraction !== null ? <Button label="Continue" kind="secondary" wide onPress={() => onDone()} />
          : (
            <>
              <Button label={model.kind === 'error' ? 'Retry Download' : 'Download Speech Model'} kind="primary" wide disabled={busy} onPress={onDownload} />
              <Button label="Use an Endpoint Instead" kind="ghost" wide onPress={() => onDone('transcription')} />
            </>
          )}
    </Page>
  );
}

function Page({ glyph, title, body, children }: { glyph: ReactNode; title: string; body: string; children: ReactNode }) {
  // Scrolls only when large text sizes outgrow the screen.
  return (
    <ScrollView contentContainerStyle={s.page} alwaysBounceVertical={false}>
      <View style={s.copy}>
        {glyph}
        <Text style={type.largeTitle} accessibilityRole="header">{title}</Text>
        <Text style={[type.body, { color: color.muted }]}>{body}</Text>
      </View>
      <View style={s.actions}>{children}</View>
    </ScrollView>
  );
}

/** Each step arrives with a short rise and fade; under Reduce Motion it only fades. */
function Reveal({ children }: { children: ReactNode }) {
  const reduceMotion = useContext(ReducedMotionContext);
  const [shown] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(shown, { toValue: 1, duration: reduceMotion ? 150 : 260, easing: Easing.out(Easing.exp), useNativeDriver: true }).start();
  }, [shown, reduceMotion]);
  const rise = reduceMotion ? [] : [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }];
  return <Animated.View style={[s.reveal, { opacity: shown, transform: rise }]}>{children}</Animated.View>;
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.page },
  reveal: { flex: 1 },
  page: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 12, justifyContent: 'space-between' },
  copy: { flex: 1, justifyContent: 'center', gap: 14 },
  actions: { gap: 10 },
  mic: { width: 72, height: 72, borderRadius: 36, borderWidth: 2, borderColor: color.blue, backgroundColor: color.card, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  micGlyph: { width: 22, height: 32, borderRadius: 11, backgroundColor: color.blue },
});
