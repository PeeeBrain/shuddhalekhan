import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useMobileApp } from './src/useMobileApp';
import { ApprovalSheet } from './src/ui/ApprovalSheet';
import { getDictationReadiness } from './src/dictation-preferences';
import { HomeScreen } from './src/ui/HomeScreen';
import { Onboarding } from './src/ui/Onboarding';
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
  // First run is derived, not stored: a microphone iOS has never asked about means nobody has set this app up.
  // Undecided (null) for the one native read at launch, so Home never flashes before onboarding.
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  // A launch from the Live Activity, Control Center, or a keyboard link may already have decided; that wins.
  useEffect(() => {
    void getDictationReadiness().then(r => setOnboarding(prev => prev ?? r.microphone === 'undetermined'), () => setOnboarding(prev => prev ?? false));
  }, []);
  useEffect(() => { if (app.keyboardSession.active) setOnboarding(false); }, [app.keyboardSession.active]);
  useEffect(() => { if (app.activityOpenCount) { setSettings(null); setOnboarding(false); } }, [app.activityOpenCount]);
  // The Control Center tile dictates on Home, so leave Settings when it opens the app.
  useEffect(() => { if (app.controlDictationOpenCount) { setSettings(null); setOnboarding(false); } }, [app.controlDictationOpenCount]);

  return (
    <>
      {onboarding === null ? null : onboarding ? <Onboarding app={app} onDone={page => { setOnboarding(false); if (page) setSettings({ page }); }} /> : settings ? (
        <SettingsScreen app={app} initialPage={settings.page} onClose={() => setSettings(null)} />
      ) : (
        <HomeScreen app={app} onOpenSettings={page => setSettings({ page })} onReviewApproval={() => setReviewingApproval(app.approval?.approvalId ?? null)} />
      )}
      <ApprovalSheet approval={app.approval && (!app.approvalNotified || reviewingApproval === app.approval.approvalId || app.approvalReviewId === app.approval.approvalId) ? app.approval : null} onResolve={app.resolveApproval} />
    </>
  );
}
