import { useContext, useEffect, useRef, useState } from 'react';
import { FlatList, Modal, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fetch } from 'expo/fetch';
import { MCPConnection, type MCPTool } from '../mcp';
import { settingsError, toolApprovalPolicy, toolApprovalPolicySchema, type MCPServerSettings } from '../settings';
import { Button, Choice, Field, ReducedMotionContext, styles, type } from './kit';

const options = [
  { value: 'alwaysAsk', label: 'Ask every time' },
  { value: 'alwaysAllow', label: 'Always allow' },
  { value: 'disabled', label: 'Disabled' },
];
type Discovery = { phase: 'idle' | 'loading' } | { phase: 'ready'; tools: MCPTool[] } | { phase: 'failed'; error: string };

export function MCPToolPolicies({ server, allowHTTP, onChange }: {
  server: MCPServerSettings;
  allowHTTP: boolean;
  onChange: (policies: NonNullable<MCPServerSettings['toolPolicies']>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [discovery, setDiscovery] = useState<Discovery>({ phase: 'idle' });
  const request = useRef<AbortController | null>(null);
  const reduceMotion = useContext(ReducedMotionContext);
  useEffect(() => {
    setDiscovery({ phase: 'idle' });
    setQuery('');
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
  const close = () => {
    request.current?.abort();
    request.current = null;
    if (discovery.phase === 'loading') setDiscovery({ phase: 'idle' });
    setOpen(false);
  };
  const tools = new Map(discovery.phase === 'ready' ? discovery.tools.map(tool => [tool.name, tool]) : []);
  // Saved policies remain editable offline, including tools no longer advertised by the server.
  const names = [...new Set([...tools.keys(), ...Object.keys(server.toolPolicies ?? {})])];
  const shown = names.filter(name => `${name} ${tools.get(name)?.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const setPolicy = (name: string, value: string) => {
    const policy = toolApprovalPolicySchema.parse(value);
    const policies = { ...server.toolPolicies, [name]: policy };
    if (policy === 'alwaysAsk') delete policies[name];
    onChange(policies);
  };

  return <>
    <Button label="Tool approval policies" onPress={() => setOpen(true)} />
    {open ? <Modal visible animationType={reduceMotion ? 'none' : 'slide'} presentationStyle="pageSheet" onRequestClose={close}>
      <SafeAreaView style={styles.sheet} edges={['bottom', 'left', 'right']}>
        <View style={styles.sheetHeader}>
          <Text style={[type.headline, { flex: 1 }]} accessibilityRole="header">{server.name || 'MCP server'} tools</Text>
          <Button label="Done" kind="ghost" onPress={close} />
        </View>
        <Text style={type.footnote}>New tools ask every time. Always allow lets this tool act without a prompt. Disabled tools are unavailable to the agent. Changes apply after you save Settings.</Text>
        <Button label={discovery.phase === 'loading' ? 'Discovering tools…' : 'Discover tools'} disabled={discovery.phase === 'loading' || !server.endpoint.trim()} onPress={() => { void discover(); }} />
        {discovery.phase === 'failed' ? <Text style={type.body} accessibilityRole="alert">{discovery.error}</Text> : null}
        {names.length > 8 || query ? <Field label="Find a tool" value={query} onChangeText={setQuery} /> : null}
        <FlatList data={shown} keyExtractor={name => name} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
          renderItem={({ item: name }) => <View style={{ paddingVertical: 12, gap: 6 }}>
            <Choice label={name} value={toolApprovalPolicy(server, name)} options={options} onChange={value => setPolicy(name, value)} />
            {tools.get(name)?.description ? <Text style={type.footnote} numberOfLines={3}>{tools.get(name)?.description}</Text> : null}
          </View>}
          ListEmptyComponent={<Text style={type.footnote}>{query.trim() ? 'No matching tools.' : discovery.phase === 'ready' ? 'This server advertises no tools.' : 'Discover tools to choose their approval policies. Discovery does not run any tools.'}</Text>} />
      </SafeAreaView>
    </Modal> : null}
  </>;
}
