import type { McpServerRuntimeStatus, McpStatusSnapshot } from '../types/ipc';

export class McpStatusStore {
  private revision = 0;
  private serverIds: string[] = [];
  private statuses = new Map<string, McpServerRuntimeStatus>();
  // Enabled-server ids are the keys of this set.
  private enabledIds = new Set<string>();

  configure(servers: Array<{ id: string; enabled?: boolean }>): McpStatusSnapshot {
    const nextIds = servers.map((server) => server.id);
    const nextStatuses = new Map<string, McpServerRuntimeStatus>();
    for (const server of servers) {
      const serverId = server.id;
      nextStatuses.set(
        serverId,
        server.enabled === false
          ? { serverId, status: 'disconnected' }
          : this.statuses.get(serverId) ?? { serverId, status: 'disconnected' }
      );
    }
    this.serverIds = nextIds;
    this.statuses = nextStatuses;
    this.enabledIds = new Set(servers.filter((server) => server.enabled !== false).map((server) => server.id));
    this.revision += 1;
    return this.getSnapshot();
  }

  record(status: McpServerRuntimeStatus): McpStatusSnapshot {
    // A stale event from a previous generation must not resurrect a server
    // that config now reports as disabled/disconnected.
    if (!this.enabledIds.has(status.serverId)) return this.getSnapshot();
    this.statuses.set(status.serverId, { ...status });
    this.revision += 1;
    return this.getSnapshot();
  }

  reset(): McpStatusSnapshot {
    for (const serverId of this.serverIds) {
      this.statuses.set(serverId, { serverId, status: 'disconnected' });
    }
    this.revision += 1;
    return this.getSnapshot();
  }

  getSnapshot(): McpStatusSnapshot {
    return {
      revision: this.revision,
      servers: this.serverIds.map(
        (serverId) => this.statuses.get(serverId) ?? { serverId, status: 'disconnected' }
      ),
    };
  }
}
