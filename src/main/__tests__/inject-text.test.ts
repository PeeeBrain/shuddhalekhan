import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { installElectronMock } from '../../test/electron-mock';
import type { injectIntoFocusedApp as InjectIntoFocusedApp } from '../inject-text';

const vi = { fn: mock };
let injectIntoFocusedApp: typeof InjectIntoFocusedApp;

installElectronMock();
mock.module('../native/clipboard', () => ({ simulatePaste: vi.fn() }));

describe('injectIntoFocusedApp', () => {
  let readText: ReturnType<typeof vi.fn>;
  let writeText: ReturnType<typeof vi.fn>;
  let simulatePaste: ReturnType<typeof vi.fn>;
  let delay: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ injectIntoFocusedApp } = await import(`../inject-text?test=${Date.now()}-${Math.random()}`));
    readText = vi.fn(() => 'original clipboard');
    writeText = vi.fn();
    simulatePaste = vi.fn();
    delay = vi.fn(async () => undefined);
  });

  it('writes text, simulates paste, and restores the previous clipboard text', async () => {
    await injectIntoFocusedApp('transcribed text', {
      readText,
      writeText,
      simulatePaste,
      delay,
    });

    expect(readText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenNthCalledWith(1, 'transcribed text');
    expect(delay).toHaveBeenNthCalledWith(1, 50);
    expect(simulatePaste).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenNthCalledWith(2, 100);
    expect(writeText).toHaveBeenNthCalledWith(2, 'original clipboard');
  });

  it('does not restore when the previous clipboard was empty', async () => {
    readText.mockReturnValue('');

    await injectIntoFocusedApp('text', {
      readText,
      writeText,
      simulatePaste,
      delay,
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('text');
  });
});
