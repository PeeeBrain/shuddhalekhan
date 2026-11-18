import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { COMPUTER_USE_TOOLS } from '../../../shared/computer-use';

type RpcMessage = { id?: number; method: string; params: { name: string; protocolVersion: string } };
const executable = process.argv[1];
const home = process.env.AGENT_DESKTOP_HOME;
const input = createInterface({ input: process.stdin });
let snapshot = 0;
let waiting: ReturnType<typeof setInterval> | undefined;

input.on('line', line => {
  const { id, method, params }: RpcMessage = JSON.parse(line);
  function send(result: unknown) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }
  function output(data: unknown) {
    send({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] });
  }
  if (method === 'initialize') {
    send({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
  } else if (method === 'tools/list') {
    const tools = executable.endsWith('-drift') ? COMPUTER_USE_TOOLS.slice(1) : COMPUTER_USE_TOOLS;
    send({ tools: tools.map(({ name }) => ({ name, inputSchema: { type: 'object' } })) });
  } else if (method === 'tools/call') {
    appendFileSync(executable + '.calls', params.name + '\n');
    if (params.name === 'desktop_snapshot') {
      const id = `snap${++snapshot}`;
      output({ snapshot_id: id, tree: { ref_id: `@${id}:e1` } });
    } else if (params.name === 'desktop_list_windows') {
      send({ content: [{ type: 'text', text: 'agent-desktop panicked' }] });
    } else if (params.name === 'desktop_wait') {
      waiting = setInterval(() => undefined, 60_000);
    } else {
      output({ home, pid: process.pid, secretInherited: 'NATIVE_FIXTURE_KEY' in process.env });
    }
  } else if (method === 'notifications/cancelled') {
    appendFileSync(executable + '.calls', 'cancelled\n');
    clearInterval(waiting);
  }
});
