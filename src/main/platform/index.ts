import { createLinuxProvider } from './linux-provider';
import { createMacosProvider } from './macos-provider';
import type { PlatformProvider, SupportedPlatform } from './types';
import { createWindowsProvider } from './windows-provider';

export function createPlatformProvider(): PlatformProvider {
  return createPlatformProviderForTest(process.platform as SupportedPlatform);
}

export function createPlatformProviderForTest(
  platform: SupportedPlatform,
  env: NodeJS.ProcessEnv = process.env
): PlatformProvider {
  if (platform === 'darwin') return createMacosProvider();
  if (platform === 'linux') return createLinuxProvider(env);
  return createWindowsProvider();
}
