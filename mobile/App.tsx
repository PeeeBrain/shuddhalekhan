import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useMobileApp } from './src/useMobileApp';
import { ApprovalSheet } from './src/ui/ApprovalSheet';
import { HomeScreen } from './src/ui/HomeScreen';
import { SettingsScreen, type SettingsPage } from './src/ui/SettingsScreen';
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
  // null = Home; otherwise Settings, opened at an optional page.
  const [settings, setSettings] = useState<{ page?: SettingsPage } | null>(null);
  const [reviewingApproval, setReviewingApproval] = useState<string | null>(null);
  useEffect(() => { if (app.activityOpenCount) setSettings(null); }, [app.activityOpenCount]);

  return (
    <>
      {settings ? (
        <SettingsScreen app={app} initialPage={settings.page} onClose={() => setSettings(null)} />
      ) : (
        <HomeScreen app={app} onOpenSettings={page => setSettings({ page })} onReviewApproval={() => setReviewingApproval(app.approval?.approvalId ?? null)} />
      )}
      <ApprovalSheet approval={app.approval && (!app.approvalNotified || reviewingApproval === app.approval.approvalId || app.approvalReviewId === app.approval.approvalId) ? app.approval : null} onResolve={app.resolveApproval} />
    </>
  );
}
