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
