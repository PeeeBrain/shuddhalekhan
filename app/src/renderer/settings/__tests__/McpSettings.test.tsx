import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
        onTest={() => undefined}
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
  const onChange = mock(() => undefined);
  render(<McpSettings servers={servers} statuses={{}} agentEnabled={agentEnabled} onChange={onChange} onTest={() => undefined} />);
  return onChange;
}

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
    renderSettings([makeServer({ type: 'stdio', command: 'bun', args: [], envVarNames: [] })]);

    expect(screen.queryByLabelText('OAuth client ID')).toBeNull();
  });
});

describe('McpSettings registry header', () => {
  it('shows a compact configured-servers header without a count chip', () => {
    renderSettings([makeServer(httpTransport), makeServer(httpTransport, [], 'srv-2')]);

    expect(screen.getByRole('heading', { name: 'Configured servers' })).toBeDefined();
    expect(screen.getByText('2 configured')).toBeDefined();
  });
});

it('requires Agent Mode before reconnecting a server', () => {
  renderSettings([makeServer(httpTransport)], false);
  expect(screen.getByRole('button', { name: 'Reconnect' })).toBeDisabled();
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
