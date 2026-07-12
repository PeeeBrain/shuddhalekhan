import { describe, expect, it } from 'bun:test';
import type { McpServerConfig } from '../../../types/ipc';
import {
  createBlankMcpServer,
  createHttpMcpTransport,
  formatTransport,
  normalizeDraftServer,
  splitCommaList,
  splitList,
} from '../mcp-settings-model';

describe('MCP settings model helpers', () => {
  it('creates a blank stdio server draft', () => {
    const server = createBlankMcpServer(() => 'mcp-fixed');

    expect(server).toEqual({
      id: 'mcp-fixed',
      displayName: '',
      enabled: false,
      transport: {
        type: 'stdio',
        command: '',
        args: [],
        envVarNames: [],
      },
      discoveredTools: [],
      toolPolicies: {},
    });
  });

  it('creates new HTTP transports with redirects denied', () => {
    expect(createHttpMcpTransport()).toEqual({
      type: 'http',
      url: '',
      redirect: 'error',
    });
  });

  it('normalizes draft names and preserves existing IDs while editing', () => {
    const server: McpServerConfig = {
      id: 'draft-id',
      displayName: '   ',
      enabled: false,
      transport: { type: 'http', url: 'http://localhost:3000/mcp', redirect: 'error' },
      discoveredTools: [],
      toolPolicies: {},
    };

    expect(normalizeDraftServer(server, 'existing-id', () => 'new-id')).toEqual({
      ...server,
      id: 'existing-id',
      displayName: 'MCP Server',
    });
    expect(normalizeDraftServer({ ...server, displayName: ' Search ' }, null, () => 'new-id')).toEqual({
      ...server,
      id: 'new-id',
      displayName: 'Search',
    });
  });

  it('formats transports and splits user-entered lists', () => {
    expect(formatTransport({
      id: 'http',
      displayName: 'HTTP',
      enabled: true,
      transport: { type: 'http', url: '', redirect: 'error' },
      discoveredTools: [],
      toolPolicies: {},
    })).toBe('HTTP endpoint not set');
    expect(formatTransport({
      id: 'stdio',
      displayName: 'stdio',
      enabled: true,
      transport: { type: 'stdio', command: 'bun', args: ['run', 'server.ts'], envVarNames: [] },
      discoveredTools: [],
      toolPolicies: {},
    })).toBe('bun run server.ts');
    expect(splitCommaList('A, B,, C ')).toEqual(['A', 'B', 'C']);
    expect(splitList(' run   server.ts ')).toEqual(['run', 'server.ts']);
  });
});
