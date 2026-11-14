import { useEffect, useRef, useState } from 'react';
import { fetch } from 'expo/fetch';
import { Button, Form, Picker, ProgressView, Section, Text, useNativeState } from '@expo/ui/swift-ui';
import { disabled, foregroundStyle, navigationTitle, pickerStyle, searchable, tag } from '@expo/ui/swift-ui/modifiers';
import { MCPConnection, type MCPTool } from '../mcp';
import { settingsError, toolApprovalPolicy, toolApprovalPolicySchema, type MCPServerSettings } from '../settings';
import { color } from './kit';

type Discovery = { phase: 'idle' | 'loading' } | { phase: 'ready'; tools: MCPTool[] } | { phase: 'failed'; error: string };

/** Native drill-down page for one server's tool policies. Edits go into the Settings draft. */
export function MCPToolPolicies({ server, allowHTTP, onChange }: {
  server: MCPServerSettings;
  allowHTTP: boolean;
  onChange: (policies: NonNullable<MCPServerSettings['toolPolicies']>) => void;
}) {
  const search = useNativeState('');
  const [query, setQuery] = useState('');
  const [discovery, setDiscovery] = useState<Discovery>({ phase: 'idle' });
  // Rows listed at the last edit, so resetting a tool to Ask Every Time (which drops its saved policy) keeps its row.
  const [listed, setListed] = useState<string[]>([]);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setDiscovery({ phase: 'idle' });
    setListed([]);
    return () => { request.current?.abort(); request.current = null; };
  }, [server.endpoint, server.token, allowHTTP]);

  const discover = async () => {
    if (request.current) return;
    const active = new AbortController();
    request.current = active;
    setDiscovery({ phase: 'loading' });
    const connection = new MCPConnection(server, fetch, allowHTTP);
    try {
      const tools = await connection.connect(active.signal);
      if (!active.signal.aborted) setDiscovery({ phase: 'ready', tools });
    } catch (error) {
      if (!active.signal.aborted) setDiscovery({ phase: 'failed', error: settingsError(error) });
    } finally {
      await connection.close();
      if (request.current === active) request.current = null;
    }
  };
  const tools = new Map(discovery.phase === 'ready' ? discovery.tools.map(tool => [tool.name, tool]) : []);
  // Saved policies remain editable offline, including tools no longer advertised by the server.
  const names = [...new Set([...tools.keys(), ...listed, ...Object.keys(server.toolPolicies ?? {})])];
  const shown = names.filter(name => `${name} ${tools.get(name)?.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const setPolicy = (name: string, value: string) => {
    const policy = toolApprovalPolicySchema.parse(value);
    const policies = { ...server.toolPolicies, [name]: policy };
    if (policy === 'alwaysAsk') delete policies[name];
    setListed(names);
    onChange(policies);
  };

  return (
    <Form modifiers={[navigationTitle('Tool Approval'), searchable(search, { prompt: 'Search tools', onChange: setQuery })]}>
      <Section footer={<Text modifiers={discovery.phase === 'failed' ? [foregroundStyle(color.red)] : undefined}>
        {discovery.phase === 'failed' ? discovery.error : 'Discovery lists tools without running them. Changes apply when you save.'}
      </Text>}>
        {discovery.phase === 'loading'
          ? <ProgressView><Text>Discovering tools…</Text></ProgressView>
          : <Button label={discovery.phase === 'ready' ? 'Refresh Tools' : 'Discover Tools'} systemImage="arrow.clockwise"
            onPress={() => { void discover(); }} modifiers={[disabled(!server.endpoint.trim())]} />}
      </Section>
      {shown.length ? shown.map(name => (
        <Section key={name} footer={tools.get(name)?.description ? <Text>{tools.get(name)?.description ?? ''}</Text> : undefined}>
          <Picker label={name} selection={toolApprovalPolicy(server, name)} onSelectionChange={v => setPolicy(name, String(v))} modifiers={[pickerStyle('menu')]}>
            <Text modifiers={[tag('alwaysAsk')]}>Ask Every Time</Text>
            <Text modifiers={[tag('alwaysAllow')]}>Always Allow</Text>
            <Text modifiers={[tag('disabled')]}>Disabled</Text>
          </Picker>
        </Section>
      )) : discovery.phase === 'ready' || query.trim() ? (
        <Section><Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
          {query.trim() ? 'No matching tools.' : 'This server advertises no tools.'}
        </Text></Section>
      ) : null}
    </Form>
  );
}
