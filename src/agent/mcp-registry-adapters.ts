import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { OAuthClientProvider } from '@ai-sdk/mcp';
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

export interface McpOAuthProviderResolver {
  resolve(server: McpServerConfig, oauthTokens?: { access_token: string }): OAuthClientProvider | undefined;
}

export class SidecarOAuthRedirectFactory implements OAuthRedirectServerFactory, McpOAuthProviderResolver {
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

  resolve(server: McpServerConfig, oauthTokens?: { access_token: string }): OAuthClientProvider | undefined {
    const provider = this.providers.get(server.id);
    if (!provider || !oauthTokens) return provider;

    if (provider.tokens()?.access_token !== oauthTokens.access_token) {
      provider.saveTokens({
        ...(provider.tokens() ?? {}),
        access_token: oauthTokens.access_token,
        token_type: provider.tokens()?.token_type ?? 'Bearer',
      });
    }
    return provider;
  }
}

export class AisdkMcpClientFactory implements McpClientFactory {
  constructor(private readonly oauthProviderResolver: McpOAuthProviderResolver) {}

  async connect(server: McpServerConfig, oauthTokens?: { access_token: string }): Promise<McpClientConnection> {
    const client = await createMCPClient({
      transport: createTransport(
        server,
        server.transport.type === 'http' ? this.oauthProviderResolver.resolve(server, oauthTokens) : undefined
      ),
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

function createTransport(server: McpServerConfig, oauthProvider?: OAuthClientProvider) {
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
