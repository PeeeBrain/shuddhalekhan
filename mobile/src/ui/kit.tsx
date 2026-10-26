/* oxlint-disable react/only-export-components -- Native screens share these controls and their style tokens. */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View, type TextInputProps } from 'react-native';

// Lampblack & Cinnabar tokens from DESIGN.md. Blue = Dictation/interaction, Vermilion = Agent Mode only.
export const color = {
  blue: '#719ed6',
  vermilion: '#e08652',
  canvas: '#0e0d0b',
  page: '#12100f',
  card: '#191715',
  raised: '#262422',
  hairline: '#393632',
  text: '#f1efe9',
  muted: '#9c958b',
  onSignal: '#141210',
  red: '#d1616a',
  green: '#5eba8f',
  ochre: '#daa64e',
  agentCard: '#211a15', // ~7% Vermilion mixed into Soot Card
  agentBorder: 'rgba(224,134,82,0.4)',
};

// iOS text styles; system font (SF) and Dynamic Type come from leaving fontFamily unset.
export const type = StyleSheet.create({
  largeTitle: { fontSize: 28, fontWeight: '700', color: color.text },
  title: { fontSize: 20, fontWeight: '600', color: color.text },
  headline: { fontSize: 17, fontWeight: '600', color: color.text },
  body: { fontSize: 17, color: color.text, lineHeight: 24 },
  footnote: { fontSize: 13, color: color.muted, lineHeight: 18 },
  caption: { fontSize: 12, color: color.muted, fontWeight: '500' },
});

type ButtonKind = 'primary' | 'agent' | 'secondary' | 'ghost' | 'destructive';

export function Button({
  label,
  onPress,
  kind = 'secondary',
  disabled,
  accessibilityLabel,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={4}
      style={({ pressed }) => [
        styles.button,
        buttonFill[kind],
        pressed && { opacity: 0.75 },
        disabled && { opacity: 0.45 },
      ]}
    >
      <Text style={[styles.buttonLabel, { color: buttonText[kind] }]}>{label}</Text>
    </Pressable>
  );
}

const buttonFill = StyleSheet.create({
  primary: { backgroundColor: color.blue },
  agent: { backgroundColor: color.vermilion },
  secondary: { backgroundColor: color.raised },
  ghost: { backgroundColor: 'transparent' },
  destructive: { backgroundColor: 'transparent', borderWidth: 1, borderColor: color.red },
});

const buttonText: Record<ButtonKind, string> = {
  primary: color.onSignal,
  agent: color.onSignal,
  secondary: color.text,
  ghost: color.blue,
  destructive: color.red,
};

export function Card({ children, agent }: { children: ReactNode; agent?: boolean }) {
  return <View style={[styles.card, agent && styles.agentCard]}>{children}</View>;
}

export function Section({ title, footer, children }: { title: string; footer?: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[type.caption, styles.sectionTitle]} accessibilityRole="header">
        {title}
      </Text>
      <Card>{children}</Card>
      {footer ? <Text style={[type.footnote, styles.sectionFooter]}>{footer}</Text> : null}
    </View>
  );
}

// Plain text/URL/secret field. Settings values are machine strings: never autocorrect or autocapitalize.
export function Field({
  label,
  hint,
  secret,
  ...input
}: { label: string; hint?: string; secret?: boolean } & Omit<TextInputProps, 'style'>) {
  return (
    <View style={styles.field}>
      <Text style={type.caption}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        secureTextEntry={secret}
        textContentType={secret ? 'password' : 'none'}
        keyboardAppearance="dark"
        placeholderTextColor={color.muted}
        selectionColor={color.blue}
        style={[styles.input, input.multiline && styles.multiline]}
        {...input}
      />
      {hint ? <Text style={type.footnote}>{hint}</Text> : null}
    </View>
  );
}

export function ToggleRow({
  label,
  hint,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={type.body}>{label}</Text>
        {hint ? <Text style={type.footnote}>{hint}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={label}
        accessibilityHint={hint}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ true: color.blue, false: color.hairline }}
        thumbColor={color.text}
        ios_backgroundColor={color.hairline}
      />
    </View>
  );
}

// One option of a `styles.segments` radiogroup.
export function Segment({
  label,
  selected,
  agent,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  agent?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: !!disabled }}
      style={[styles.segment, selected && styles.segmentOn, disabled && { opacity: 0.45 }]}
    >
      <Text style={[type.headline, { color: selected ? (agent ? color.vermilion : color.blue) : color.muted }]}>{label}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  segments: {
    flexDirection: 'row',
    backgroundColor: color.card,
    borderRadius: 10,
    padding: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  segment: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  segmentOn: { backgroundColor: color.raised },
  button: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  card: {
    backgroundColor: color.card,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    padding: 16,
    gap: 12,
  },
  agentCard: { backgroundColor: color.agentCard, borderColor: color.agentBorder, borderRadius: 6 },
  section: { gap: 6 },
  sectionTitle: { paddingHorizontal: 4 },
  sectionFooter: { paddingHorizontal: 4 },
  field: { gap: 6 },
  input: {
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: color.hairline,
    backgroundColor: 'rgba(57,54,50,0.3)',
    color: color.text,
    fontSize: 17,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
