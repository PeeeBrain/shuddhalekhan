import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useMobileApp } from './src/useMobileApp';
import { ApprovalSheet } from './src/ui/ApprovalSheet';
import { HomeScreen } from './src/ui/HomeScreen';
import { SettingsScreen } from './src/ui/SettingsScreen';
import { ReducedMotionContext } from './src/ui/kit';

export default function App() {
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let mounted = true;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (mounted) setReduceMotion(value);
    }).catch(() => {});
    return () => { mounted = false; subscription.remove(); };
  }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <ReducedMotionContext value={reduceMotion}><Main /></ReducedMotionContext>
    </SafeAreaProvider>
  );
}

function Main() {
  const app = useMobileApp();
  const [screen, setScreen] = useState<'home' | 'settings'>('home');

  return (
    <>
      {screen === 'settings' ? (
        <SettingsScreen
          settings={app.settings}
          localModels={app.localModels}
          preparingModel={app.preparingModel}
          onInstallLocalModel={app.installLocalModel}
          canSave={app.phase === 'idle'}
          onSave={app.saveSettings}
          onClose={() => setScreen('home')}
        />
      ) : (
        <HomeScreen app={app} onOpenSettings={() => setScreen('settings')} />
      )}
      <ApprovalSheet approval={app.approval} onResolve={app.resolveApproval} />
    </>
  );
}
