import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { useMobileApp } from '../useMobileApp';
import { Button, Card, color, type } from './kit';

type Approval = NonNullable<ReturnType<typeof useMobileApp>['approval']>;

// Any dismissal (swipe down, Deny) denies. Only the explicit button approves, and only this one call.
export function ApprovalSheet({ approval, onResolve }: { approval: Approval | null; onResolve: (approved: boolean) => void }) {
  return (
    <Modal
      visible={approval !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal
      onRequestClose={() => onResolve(false)}
    >
      <SafeAreaView style={a.screen} edges={['bottom', 'left', 'right']}>
        <ScrollView contentContainerStyle={a.content}>
          <Text style={[type.caption, { color: color.vermilion }]}>Agent wants to use a tool</Text>
          <Text style={type.title} accessibilityRole="header">
            {approval?.toolName}
          </Text>
          <Text style={type.footnote}>from {approval?.serverName}</Text>
          <Card agent>
            <Text style={type.caption}>Arguments</Text>
            <Text style={a.args} selectable>
              {approval?.arguments || '(none)'}
            </Text>
          </Card>
        </ScrollView>
        <View style={a.actions}>
          <Button label="Approve once" kind="agent" onPress={() => onResolve(true)} />
          <Button label="Deny" kind="secondary" onPress={() => onResolve(false)} />
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
