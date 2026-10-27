import { useContext, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { useMobileApp } from '../useMobileApp';
import type { ApprovalDecision } from '../controller';
import { Button, Card, ReducedMotionContext, color, type } from './kit';

type Approval = NonNullable<ReturnType<typeof useMobileApp>['approval']>;

// Any dismissal (swipe down, Deny) denies. Only the explicit button approves, and only this one call.
export function ApprovalSheet({ approval, onResolve }: { approval: Approval | null; onResolve: (decision: ApprovalDecision) => void }) {
  const reduceMotion = useContext(ReducedMotionContext);
  // Keep the last request on screen while the sheet slides away, so it doesn't blank mid-dismissal.
  const [shown, setShown] = useState(approval);
  if (approval && approval !== shown) setShown(approval);
  const decide = (approved: boolean) => {
    if (shown) onResolve({ runId: shown.runId, approvalId: shown.approvalId, approved });
  };
  return (
    <Modal
      key={shown?.approvalId ?? 'approval'}
      visible={approval !== null}
      animationType={reduceMotion ? 'none' : 'slide'}
      presentationStyle="pageSheet"
      allowSwipeDismissal
      onRequestClose={() => decide(false)}
    >
      <SafeAreaView style={a.screen} edges={['bottom', 'left', 'right']}>
        <ScrollView contentContainerStyle={a.content}>
          <Text style={[type.caption, { color: color.vermilion }]}>Agent wants to use a tool</Text>
          <Text style={type.title} accessibilityRole="header">
            {shown?.toolName}
          </Text>
          <Text style={type.footnote}>from {shown?.serverName}</Text>
          <Card agent>
            <Text style={type.caption}>Arguments</Text>
            <Text style={a.args} selectable>
              {shown?.arguments || '(none)'}
            </Text>
          </Card>
        </ScrollView>
        <View style={a.actions}>
          <Button label="Approve once" kind="agent" disabled={approval === null} onPress={() => decide(true)} />
          <Button label="Deny" kind="secondary" disabled={approval === null} onPress={() => decide(false)} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const a = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.page },
  content: { padding: 20, paddingTop: 28, gap: 8 },
  args: { fontFamily: 'Menlo', fontSize: 14, lineHeight: 20, color: color.text },
  actions: { padding: 20, gap: 10 },
});
