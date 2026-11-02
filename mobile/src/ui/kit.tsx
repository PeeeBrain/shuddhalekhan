/* oxlint-disable react/only-export-components -- Native screens share these controls and their style tokens. */
import { createContext, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button as SwiftButton, Host, Text as SwiftText } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled as off, frame, labelStyle, tint } from '@expo/ui/swift-ui/modifiers';

export const ReducedMotionContext = createContext(true);

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
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700', color: color.text },
  title: { fontSize: 20, fontWeight: '600', color: color.text },
  headline: { fontSize: 17, fontWeight: '600', color: color.text },
  body: { fontSize: 17, color: color.text, lineHeight: 24 },
  footnote: { fontSize: 13, color: color.muted, lineHeight: 18 },
  caption: { fontSize: 12, color: color.muted, fontWeight: '500' },
});

type ButtonKind = 'primary' | 'agent' | 'secondary' | 'ghost' | 'destructive';
const swiftStyle = { primary: 'borderedProminent', agent: 'borderedProminent', secondary: 'bordered', ghost: 'borderless', destructive: 'bordered' } as const;

/** A native SwiftUI button. `wide` fills the row; otherwise it sizes to its label. */
export function Button({ label, onPress, kind = 'secondary', small, wide, disabled, systemImage, iconOnly }: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  small?: boolean;
  wide?: boolean;
  disabled?: boolean;
  systemImage?: Parameters<typeof SwiftButton>[0]['systemImage'];
  iconOnly?: boolean;
}) {
  const modifiers = [
    buttonStyle(swiftStyle[kind]),
    controlSize(small ? 'small' : wide ? 'large' : 'regular'),
    ...(kind === 'destructive' ? [] : [tint(kind === 'agent' ? color.vermilion : color.blue)]),
    ...(iconOnly ? [labelStyle('iconOnly')] : []),
    off(!!disabled),
  ];
  return (
    <Host matchContents={wide ? { vertical: true } : true} colorScheme="dark">
      {wide ? (
        <SwiftButton onPress={onPress} role={kind === 'destructive' ? 'destructive' : 'default'} modifiers={modifiers}>
          <SwiftText modifiers={[frame({ maxWidth: Infinity })]}>{label}</SwiftText>
        </SwiftButton>
      ) : (
        <SwiftButton label={label} systemImage={systemImage} onPress={onPress} role={kind === 'destructive' ? 'destructive' : 'default'} modifiers={modifiers} />
      )}
    </Host>
  );
}

export function Card({ children, agent }: { children: ReactNode; agent?: boolean }) {
  return <View style={[styles.card, agent && styles.agentCard]}>{children}</View>;
}

export const styles = StyleSheet.create({
  card: {
    backgroundColor: color.card,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    padding: 16,
    gap: 12,
  },
  agentCard: { backgroundColor: color.agentCard, borderColor: color.agentBorder, borderRadius: 6 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
