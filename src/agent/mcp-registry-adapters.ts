import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { Tool } from 'ai';
import type { McpServerConfig } from '../types/ipc';
import type {
  McpClientConnection,
  McpClientFactory,
  OAuthRedirectServer,
  OAuthRedirectServerFactory,
  SidecarMessageTransporter,
} from './mcp-registry';
import { SidecarOAuthProvider } from './oauth-provider';
import { logSidecar, writeJsonLine } from './protocol';

export class SidecarOAuthRedirectFactory implements OAuthRedirectServerFactory {
  private providers = new Map<string, SidecarOAuthProvider>();

  create(server: McpServerConfig): OAuthRedirectServer {
    if (server.transport.type !== 'http') throw new Error('OAuth redirect servers require an HTTP MCP server.');

    const provider = new SidecarOAuthProvider(server);
    this.providers.set(server.id, provider);
    return {
      start: () => provider.start(),
      close: async () => {
        provider.close();
        if (this.providers.get(server.id) === provider) this.providers.delete(server.id);
      },
      tokens: () => {
        const accessToken = provider.tokens()?.access_token;
        return accessToken ? { access_token: accessToken } : null;
      },
    };
  }

  getProvider(serverId: string): SidecarOAuthProvider | undefined {
    return this.providers.get(serverId);
  }
}

export class AisdkMcpClientFactory implements McpClientFactory {
  constructor(private readonly oauthFactory: SidecarOAuthRedirectFactory) {}

  async connect(server: McpServerConfig, _oauthTokens?: { access_token: string }): Promise<McpClientConnection> {
    const client = await createMCPClient({
      transport: createTransport(server, this.oauthFactory.getProvider(server.id)),
    });

    return {
      tools: async () => (await client.tools()) as Record<string, Tool>,
      close: async () => {
        await client.close();
      },
    };
  }
}

export class StdoutSidecarMessageTransporter implements SidecarMessageTransporter {
  sendStatus(
    serverId: string,
    status: 'connecting' | 'connected' | 'failed' | 'disconnected',
    message?: string
  ): void {
    writeJsonLine({ type: 'mcp:server-status', serverId, status, message });
  }

  sendDiscoveredTools(
    serverId: string,
    tools: Array<{ name: string; description: string; inputSchema?: unknown }>
  ): void {
    writeJsonLine({ type: 'mcp:tools-discovered', serverId, tools });
  }

  log(message: string, error?: unknown): void {
    logSidecar(message, error);
  }
}

function createTransport(server: McpServerConfig, oauthProvider?: SidecarOAuthProvider) {
  if (server.transport.type === 'stdio') {
    const env: Record<string, string> = {};
    for (const name of server.transport.envVarNames) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return new Experimental_StdioMCPTransport({
      command: server.transport.command,
      args: server.transport.args,
      env,
    });
  }

  return { type: 'http' as const, url: server.transport.url, authProvider: oauthProvider };
}
