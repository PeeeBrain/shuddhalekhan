import { useMemo, type ReactNode } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ListItem, Nodes, PhrasingContent, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { color, type } from './kit';

// Renders agent responses (GFM) with native Text. Raw HTML stays literal text, images show only their
// alt text (no remote fetches), and links open only for web and mail schemes.
export function Markdown({ children }: { children: string }) {
  const tree = useMemo(() => fromMarkdown(children, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }), [children]);
  return <View style={md.root}>{tree.children.map(block)}</View>;
}

const openable = /^(https?:|mailto:)/i;

function block(node: RootContent, key: number): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <Text key={key} style={type.body} selectable>{node.children.map(inline)}</Text>;
    case 'heading':
      return (
        <Text key={key} style={[type.body, md.heading, node.depth <= 2 && md.headingLarge]} accessibilityRole="header" selectable>
          {node.children.map(inline)}
        </Text>
      );
    case 'blockquote':
      return <View key={key} style={[md.root, md.quote]}>{node.children.map(block)}</View>;
    case 'list':
      return (
        <View key={key} style={md.root}>
          {node.children.map((item, i) => listItem(item, i, node.ordered ? `${(node.start ?? 1) + i}.` : '•'))}
        </View>
      );
    case 'code':
      return (
        <ScrollView key={key} horizontal style={md.codeBlock} contentContainerStyle={md.codePad}>
          <Text style={md.mono} selectable>{node.value}</Text>
        </ScrollView>
      );
    case 'table':
      // shortcut: fixed-width columns can cramp long cells; measure cells if tables need adaptive widths.
      return (
        <ScrollView key={key} horizontal style={md.table}>
          <View>
            {node.children.map((row, r) => (
              <View key={r} style={[md.row, r > 0 && md.rowRule]}>
                {row.children.map((cell, c) => (
                  <Text key={c} style={[type.body, md.cell, r === 0 && md.strong]} selectable>{cell.children.map(inline)}</Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    case 'thematicBreak':
      return <View key={key} style={md.rule} />;
    case 'html':
      return <Text key={key} style={type.body} selectable>{node.value}</Text>;
    case 'footnoteDefinition':
      return (
        <View key={key} style={md.item}>
          <Text style={type.footnote}>[{node.label ?? node.identifier}]</Text>
          <View style={[md.root, md.itemBody]}>{node.children.map(block)}</View>
        </View>
      );
    case 'listItem':
      return listItem(node, key, '•');
    default:
      // Link definitions and anything else non-visual.
      return null;
  }
}

function listItem(item: ListItem, key: number, marker: string) {
  const bullet = item.checked == null ? marker : item.checked ? '☑' : '☐';
  return (
    <View key={key} style={md.item}>
      <Text style={[type.body, md.marker]} accessibilityElementsHidden={bullet === '•'}>{bullet}</Text>
      <View style={[md.root, md.itemBody]}>{item.children.map(block)}</View>
    </View>
  );
}

function inline(node: PhrasingContent, key: number): ReactNode {
  switch (node.type) {
    case 'text':
      return node.value;
    case 'strong':
      return <Text key={key} style={md.strong}>{node.children.map(inline)}</Text>;
    case 'emphasis':
      return <Text key={key} style={md.emphasis}>{node.children.map(inline)}</Text>;
    case 'delete':
      return <Text key={key} style={md.strike}>{node.children.map(inline)}</Text>;
    case 'inlineCode':
      return <Text key={key} style={md.inlineCode}>{node.value}</Text>;
    case 'break':
      return '\n';
    case 'link': {
      const url = node.url;
      if (!openable.test(url)) return <Text key={key}>{node.children.map(inline)}</Text>;
      return (
        <Text key={key} style={md.link} accessibilityRole="link" accessibilityHint={url} onPress={() => void Linking.openURL(url).catch(() => {})}>
          {node.children.map(inline)}
        </Text>
      );
    }
    case 'image':
      return node.alt ? `[${node.alt}]` : null;
    case 'footnoteReference':
      return <Text key={key} style={type.footnote}>[{node.label ?? node.identifier}]</Text>;
    default:
      // html, linkReference, imageReference: keep their visible text without resolving anything.
      return text(node);
  }
}

function text(node: Nodes): string {
  if ('value' in node) return node.value;
  if ('alt' in node) return node.alt ?? '';
  return 'children' in node ? node.children.map(text).join('') : '';
}

const md = StyleSheet.create({
  root: { gap: 8 },
  heading: { fontWeight: '600' },
  headingLarge: { fontSize: 20, lineHeight: 26 },
  strong: { fontWeight: '600' },
  emphasis: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  link: { color: color.blue, textDecorationLine: 'underline' },
  mono: { fontFamily: 'Menlo', fontSize: 14, lineHeight: 20, color: color.text },
  inlineCode: { fontFamily: 'Menlo', fontSize: 15, backgroundColor: color.raised },
  codeBlock: { backgroundColor: color.canvas, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: color.hairline },
  codePad: { padding: 12 },
  quote: { borderLeftWidth: 3, borderLeftColor: color.hairline, paddingLeft: 12 },
  item: { flexDirection: 'row', gap: 8 },
  marker: { minWidth: 18, color: color.muted },
  itemBody: { flex: 1 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: color.hairline },
  table: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: color.hairline },
  row: { flexDirection: 'row' },
  rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  cell: { width: 160, paddingHorizontal: 10, paddingVertical: 6, fontSize: 15, lineHeight: 21 },
});
