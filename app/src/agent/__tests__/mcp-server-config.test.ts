import { describe, expect, it } from 'bun:test';
import type { McpServerConfig } from '../../types/ipc';
import { getMcpServerConnectionKey, makeMcpToolPolicyKey, normalizeMcpServers } from '../mcp-server-config';

describe('MCP server config', () => {
  it('defaults discovered tool policies and server enabled state', () => {
    const [server] = normalizeMcpServers([
      {
        id: 'mail',
        displayName: 'Hosted Mail',
        transport: { type: 'http', url: 'https://mail.example.com/mcp' },
        discoveredTools: [
          {
            name: 'read_email',
            description: 'Read email',
            discoveredAt: '2026-05-11T00:00:00.000Z',
          },
        ],
        toolPolicies: {},
      } as McpServerConfig,
    ]);

    expect(server.enabled).toBe(false);
    expect(server.transport).toEqual({
      type: 'http',
      url: 'https://mail.example.com/mcp',
      redirect: 'error',
    });
    expect(server.toolPolicies).toEqual({
      'mail:read_email': 'alwaysAsk',
    });
  });

  it('preserves an explicit HTTP redirect opt-in and includes it in the connection key', () => {
    const [followServer] = normalizeMcpServers([{
      id: 'redirecting',
      displayName: 'Redirecting server',
      enabled: true,
      transport: {
        type: 'http',
        url: 'https://redirect.example.com/mcp',
        redirect: 'follow',
      },
      discoveredTools: [],
      toolPolicies: {},
    } as McpServerConfig]);
    const [denyServer] = normalizeMcpServers([{
      ...followServer,
      transport: {
        type: 'http',
        url: 'https://redirect.example.com/mcp',
      },
    } as McpServerConfig]);

    expect(followServer.transport).toEqual({
      type: 'http',
      url: 'https://redirect.example.com/mcp',
      redirect: 'follow',
    });
    expect(getMcpServerConnectionKey(followServer)).not.toBe(getMcpServerConnectionKey(denyServer));
  });

  it('keeps multiple generic HTTP servers and existing tool policies', () => {
    const servers = normalizeMcpServers([
      {
        id: 'mail-primary',
        displayName: 'Hosted Mail',
        enabled: true,
        transport: { type: 'http', url: 'https://mail.example.com/mcp', redirect: 'error' },
        discoveredTools: [{ name: 'read_email', description: 'Read email', discoveredAt: '2026-05-11T00:00:00.000Z' }],
        toolPolicies: { 'mail-primary:read_email': 'alwaysAllow' },
      },
      {
        id: 'mail-secondary',
        displayName: 'Hosted Mail Second Account',
        enabled: true,
        transport: { type: 'http', url: 'https://mail2.example.com/mcp', redirect: 'error' },
        discoveredTools: [],
        toolPolicies: {},
      },
    ]);

    expect(servers).toHaveLength(2);
    expect(servers[0].toolPolicies).toEqual({
      'mail-primary:read_email': 'alwaysAllow',
    });
    expect(servers[1].id).toBe('mail-secondary');
  });

  it('creates stable policy keys and connection keys', () => {
    const server: McpServerConfig = {
      id: 'srv1',
      displayName: 'Server',
      enabled: true,
      transport: { type: 'stdio', command: 'bun', args: ['run', 'server.ts'], envVarNames: ['TOKEN'] },
      discoveredTools: [],
      toolPolicies: {},
    };

    expect(makeMcpToolPolicyKey('srv1', 'search')).toBe('srv1:search');
    expect(getMcpServerConnectionKey(server)).toBe(JSON.stringify({
      enabled: true,
      transport: { type: 'stdio', command: 'bun', args: ['run', 'server.ts'], envVarNames: ['TOKEN'] },
    }));
  });
});
