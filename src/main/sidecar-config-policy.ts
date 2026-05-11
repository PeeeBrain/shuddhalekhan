import type { AppConfig } from '../types/ipc';

export type SidecarConfigAction = 'none' | 'start' | 'stop';

export function getSidecarConfigAction(previousConfig: AppConfig, nextConfig: AppConfig): SidecarConfigAction {
  if (previousConfig.agent.enabled && !nextConfig.agent.enabled) {
    return 'stop';
  }

  if (!nextConfig.agent.enabled) {
    return 'none';
  }

  if (!previousConfig.agent.enabled && nextConfig.agent.enabled) {
    return 'start';
  }

  return isSidecarRuntimeConfigEqual(previousConfig, nextConfig) ? 'none' : 'start';
}

function isSidecarRuntimeConfigEqual(previousConfig: AppConfig, nextConfig: AppConfig): boolean {
  return (
    JSON.stringify(previousConfig.agent.provider) === JSON.stringify(nextConfig.agent.provider) &&
    JSON.stringify(previousConfig.agent.mcpServers) === JSON.stringify(nextConfig.agent.mcpServers)
  );
}
