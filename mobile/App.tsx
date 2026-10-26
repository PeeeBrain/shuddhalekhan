import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useMobileApp } from './src/useMobileApp';
import { ApprovalSheet } from './src/ui/ApprovalSheet';
import { HomeScreen } from './src/ui/HomeScreen';
import { SettingsScreen } from './src/ui/SettingsScreen';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Main />
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
