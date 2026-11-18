import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { McpSettings } from '../McpSettings';
import type { McpServerConfig } from '../../../types/ipc';

afterEach(cleanup);

describe('McpSettings HTTP redirect policy', () => {
  it('saves an explicit redirect opt-in from the server editor', () => {
    const server: McpServerConfig = {
      id: 'http-server',
      displayName: 'HTTP server',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://mcp.example.test/mcp',
        redirect: 'error',
      },
      discoveredTools: [],
      toolPolicies: {},
    };
    const onChange = mock(() => undefined);

    render(
      <McpSettings
        servers={[server]}
        statuses={{}}
        agentEnabled
        onChange={onChange}
        onTest={async () => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const redirectSwitch = screen.getByRole('switch', { name: 'Follow HTTP redirects' });
    expect(redirectSwitch).not.toBeChecked();

    fireEvent.click(redirectSwitch);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(onChange).toHaveBeenCalledWith([{
      ...server,
      transport: {
        ...server.transport,
        redirect: 'follow',
      },
    }]);
  });
});

const httpTransport = { type: 'http', url: 'https://mcp.example.test/mcp', redirect: 'error' } as const;

function makeServer(
  transport: McpServerConfig['transport'],
  discoveredTools: McpServerConfig['discoveredTools'] = [],
  id = 'srv-1',
): McpServerConfig {
  return {
    id,
    displayName: 'Test server',
    enabled: true,
    transport,
    discoveredTools,
    toolPolicies: {},
  };
}

function renderSettings(servers: McpServerConfig[], agentEnabled = true) {
  const onChange = mock((_servers: McpServerConfig[]) => undefined);
  render(<McpSettings servers={servers} statuses={{}} agentEnabled={agentEnabled} onChange={onChange} onTest={async () => undefined} />);
  return onChange;
}

it('adds an unnamed HTTP server with redirects denied and preserves the existing server', async () => {
  const existing = makeServer(httpTransport, [], 'saved-server');
  const onChange = renderSettings([existing]);
  const url = 'https://other.example.test/mcp';

  fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Transport' }));
  fireEvent.click(await screen.findByRole('option', { name: 'HTTP' }));
  expect(screen.getByRole('switch', { name: 'Follow HTTP redirects' })).not.toBeChecked();
  fireEvent.change(screen.getByLabelText('URL'), { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Server' }));

  expect(onChange).toHaveBeenCalledTimes(1);
  const saved = onChange.mock.calls[0]?.[0];
  expect(saved).toEqual([existing, expect.objectContaining({
    id: expect.any(String),
    displayName: 'MCP Server',
    transport: { type: 'http', url, redirect: 'error' },
  })]);
  expect(saved?.[1]?.id).not.toBe(existing.id);
});

it.each([
  ['   ', 'MCP Server'],
  ['  Lookup  ', 'Lookup'],
])('normalizes the edited MCP name %j and keeps the saved server identity', (name: string, displayName: string) => {
  const server = makeServer(httpTransport, [], 'saved-server');
  const onChange = renderSettings([server]);

  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

  expect(onChange).toHaveBeenCalledWith([{ ...server, displayName }]);
});

describe('McpSettings pre-registered OAuth client', () => {
  it('saves optional OAuth client fields from the HTTP server editor', () => {
    const onChange = renderSettings([makeServer(httpTransport)]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Client secret env var name'), { target: { value: 'MY_GOOGLE_SECRET' } });
    expect(screen.getByLabelText('Client secret env var name')).toHaveValue('MY_GOOGLE_SECRET');
    fireEvent.change(screen.getByLabelText('OAuth client ID'), { target: { value: 'my-client' } });
    fireEvent.change(screen.getByLabelText('OAuth scopes'), { target: { value: 'gmail.readonly,' } });
    expect(screen.getByLabelText('OAuth scopes')).toHaveValue('gmail.readonly,');
    fireEvent.change(screen.getByLabelText('OAuth scopes'), { target: { value: 'gmail.readonly, gmail.send' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(onChange).toHaveBeenCalledWith([{
      ...makeServer(httpTransport),
      transport: {
        ...httpTransport,
        oauth: { clientId: 'my-client', clientSecretEnvVar: 'MY_GOOGLE_SECRET', scopes: ['gmail.readonly', 'gmail.send'] },
      },
    }]);
  });

  it('round-trips existing OAuth fields and drops them when the client ID is cleared', () => {
    const server = makeServer({
      ...httpTransport,
      oauth: { clientId: 'keep-id', clientSecretEnvVar: 'S', scopes: ['gmail.readonly'] },
    });
    const onChange = renderSettings([server]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('OAuth client ID')).toHaveValue('keep-id');
    fireEvent.change(screen.getByLabelText('OAuth client ID'), { target: { value: '   ' } });
    expect(screen.getByLabelText('Client secret env var name')).toHaveValue('S');
    expect(screen.getByLabelText('OAuth scopes')).toHaveValue('gmail.readonly');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    const saved = onChange.mock.calls[0]?.[0]?.[0] as McpServerConfig;
    expect(saved.transport).toEqual(httpTransport);
  });

  it('hides OAuth fields for stdio servers', () => {
    renderSettings([makeServer({ type: 'stdio', command: 'bun', args: ['run', 'server.ts'], envVarNames: [] })]);

    expect(screen.getByText('bun run server.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Command')).toHaveValue('bun');
    expect(screen.queryByLabelText('OAuth client ID')).toBeNull();
  });
});

it('requires Agent Mode before reconnecting a server', () => {
  renderSettings([makeServer(httpTransport)], false);
  expect(screen.getByRole('button', { name: 'Reconnect' })).toBeDisabled();
});

it('labels an HTTP server with a missing endpoint', () => {
  renderSettings([makeServer({ ...httpTransport, url: '' })]);
  expect(screen.getByText('HTTP endpoint not set')).toBeInTheDocument();
});

describe('McpSettings tool policy collapse', () => {
  it('starts collapsed and expands tool policies on demand', () => {
    const server = makeServer(httpTransport, [
      { name: 'tool-a', description: 'Does A', discoveredAt: '2026-01-01T00:00:00.000Z' },
      { name: 'tool-b', description: 'Does B', discoveredAt: '2026-01-01T00:00:00.000Z' },
    ]);
    renderSettings([server]);

    expect(screen.queryByRole('combobox', { name: 'Approval policy for tool-a' })).toBeNull();
    const toggle = screen.getByRole('button', { name: /^tools/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('combobox', { name: 'Approval policy for tool-a' })).toBeDefined();
    expect(screen.getByRole('combobox', { name: 'Approval policy for tool-b' })).toBeDefined();
  });
});

it('reports a rejected server reconnect instead of leaving an unhandled rejection', async () => {
  const failure = new Error('bridge unavailable');
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(<McpSettings servers={[makeServer(httpTransport)]} statuses={{}} agentEnabled
      onChange={() => {}} onTest={async () => { throw failure; }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(log).toHaveBeenCalledWith('Failed to test MCP server:', failure));
  } finally {
    log.mockRestore();
  }
});
