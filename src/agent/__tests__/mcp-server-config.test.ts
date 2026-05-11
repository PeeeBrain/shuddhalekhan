import { describe, expect, it } from 'bun:test';
import type { McpServerConfig } from '../../types/ipc';
import { getMcpServerConnectionKey, makeMcpToolPolicyKey, normalizeMcpServers } from '../mcp-server-config';

describe('MCP server config', () => {
  it('defaults discovered tool policies and server enabled state', () => {
    const [server] = normalizeMcpServers([
      {
        id: 'gmail',
        displayName: 'Gmail',
        transport: { type: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
        discoveredTools: [
          {
            name: 'send_email',
            description: 'Send an email',
            discoveredAt: '2026-05-11T00:00:00.000Z',
          },
        ],
        toolPolicies: {},
      } as McpServerConfig,
    ]);

    expect(server.enabled).toBe(false);
    expect(server.toolPolicies).toEqual({
      'gmail:send_email': 'alwaysAsk',
    });
  });

  it('keeps existing tool policies and removes duplicate Gmail presets', () => {
    const servers = normalizeMcpServers([
      {
        id: 'gmail-primary',
        displayName: 'Gmail',
        enabled: true,
        preset: 'gmail',
        transport: { type: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
        discoveredTools: [{ name: 'read_email', description: 'Read email', discoveredAt: '2026-05-11T00:00:00.000Z' }],
        toolPolicies: { 'gmail-primary:read_email': 'alwaysAllow' },
      },
      {
        id: 'gmail-duplicate',
        displayName: 'Gmail Duplicate',
        enabled: true,
        preset: 'gmail',
        transport: { type: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
        discoveredTools: [],
        toolPolicies: {},
      },
    ]);

    expect(servers).toHaveLength(1);
    expect(servers[0].toolPolicies).toEqual({
      'gmail-primary:read_email': 'alwaysAllow',
    });
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
