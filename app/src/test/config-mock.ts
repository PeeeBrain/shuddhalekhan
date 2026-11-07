import { mock } from 'bun:test';
import type * as Config from '../main/config';

const unstubbed = (name: string) => () => { throw new Error(`config.${name} is not stubbed in this test`); };

/**
 * Bun module mocks are process-wide: a partial `config` mock makes later test files that
 * import any other config export fail to link. This stubs every export; pass what the test uses.
 */
export function mockConfigModule(overrides: Partial<Record<keyof typeof Config, unknown>>): void {
  const stubs = {
    getConfig: unstubbed('getConfig'),
    getChatGptHostId: () => undefined,
    setChatGptHostId: () => undefined,
    patchTranscriptionConfig: unstubbed('patchTranscriptionConfig'),
    setConfig: () => undefined,
    getLastSeenReleaseNotesVersion: () => null,
    setLastSeenReleaseNotesVersion: () => undefined,
    mergeDiscoveredTools: unstubbed('mergeDiscoveredTools'),
  } satisfies Record<keyof typeof Config, unknown>;
  mock.module('../main/config', () => ({ ...stubs, ...overrides }));
}
