import { describe, expect, it } from 'bun:test';
import { McpStatusStore } from '../mcp-status-store';

describe('McpStatusStore', () => {
  it('returns a complete revisioned snapshot when only some servers have reported', () => {
    const store = new McpStatusStore();

    expect(store.configure([{ id: 'mail' }, { id: 'files' }])).toEqual({
      revision: 1,
      servers: [
        { serverId: 'mail', status: 'disconnected' },
        { serverId: 'files', status: 'disconnected' },
      ],
    });

    expect(store.record({ serverId: 'mail', status: 'connected', message: 'ready' })).toEqual({
      revision: 2,
      servers: [
        { serverId: 'mail', status: 'connected', message: 'ready' },
        { serverId: 'files', status: 'disconnected' },
      ],
    });
  });

  it('drops removed servers and resets the current generation to disconnected', () => {
    const store = new McpStatusStore();
    store.configure([{ id: 'mail' }, { id: 'files' }]);
    store.record({ serverId: 'mail', status: 'connected' });

    expect(store.configure([{ id: 'mail' }])).toEqual({
      revision: 3,
      servers: [{ serverId: 'mail', status: 'connected' }],
    });
    expect(store.reset()).toEqual({
      revision: 4,
      servers: [{ serverId: 'mail', status: 'disconnected' }],
    });
  });

  it('marks a disabled server disconnected without waiting for a sidecar event', () => {
    const store = new McpStatusStore();
    store.configure([{ id: 'mail', enabled: true }]);
    store.record({ serverId: 'mail', status: 'failed', message: 'offline' });

    expect(store.configure([{ id: 'mail', enabled: false }])).toEqual({
      revision: 3,
      servers: [{ serverId: 'mail', status: 'disconnected' }],
    });
  });
});
