import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { installElectronMock } from '../../test/electron-mock';
import type {
  injectIntoFocusedApp as InjectIntoFocusedApp,
  copyLastTranscriptToClipboard as CopyLastTranscriptToClipboard,
  InjectResult,
} from '../inject-text';
import type { PasteDispatchResult } from '../native/clipboard';

const vi = { fn: mock };
let injectIntoFocusedApp: typeof InjectIntoFocusedApp;
let copyLastTranscriptToClipboard: typeof CopyLastTranscriptToClipboard;

installElectronMock();
mock.module('../native/clipboard', () => ({ simulatePaste: vi.fn() }));

describe('injectIntoFocusedApp', () => {
  let readText: ReturnType<typeof vi.fn>;
  let writeText: ReturnType<typeof vi.fn>;
  let simulatePaste: ReturnType<typeof vi.fn>;
  let delay: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ injectIntoFocusedApp, copyLastTranscriptToClipboard } = await import(
      `../inject-text?test=${Date.now()}-${Math.random()}`
    ));
    readText = vi.fn(() => 'original clipboard');
    writeText = vi.fn();
    simulatePaste = vi.fn((): PasteDispatchResult => ({ acceptedEvents: 4 }));
    delay = vi.fn(async () => undefined);
  });

  it('returns input-dispatched with the accepted event count on full dispatch', async () => {
    const result = await injectIntoFocusedApp('transcribed text', {
      readText,
      writeText,
      simulatePaste,
      delay,
    });

    expect(result).toEqual({ kind: 'input-dispatched', acceptedEvents: 4 });
    expect(readText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenNthCalledWith(1, 'transcribed text');
    expect(delay).toHaveBeenNthCalledWith(1, 50);
    expect(simulatePaste).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenNthCalledWith(2, 100);
    expect(writeText).toHaveBeenNthCalledWith(2, 'original clipboard');
  });

  it('does not restore clipboard when the previous clipboard was empty', async () => {
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

  it('returns input-blocked when zero events are accepted', async () => {
    simulatePaste.mockReturnValue({ acceptedEvents: 0, errorCode: 5 });

    const result = await injectIntoFocusedApp('text', {
      readText,
      writeText,
      simulatePaste,
      delay,
    });

    expect(result).toEqual({ kind: 'input-blocked', acceptedEvents: 0, reason: 'No input events accepted (Win32 error 5)' });
  });

  it('returns input-blocked with diagnostics for partial dispatch', async () => {
    simulatePaste.mockReturnValue({ acceptedEvents: 2, errorCode: 87 });

    const result = await injectIntoFocusedApp('text', {
      readText,
      writeText,
      simulatePaste,
      delay,
    });

    expect(result).toEqual({ kind: 'input-blocked', acceptedEvents: 2, reason: 'Partial input dispatch (Win32 error 87)' });
  });

  it('returns input-blocked without an error code when none is reported', async () => {
    simulatePaste.mockReturnValue({ acceptedEvents: 1 });

    const result = await injectIntoFocusedApp('text', {
      readText,
      writeText,
      simulatePaste,
      delay,
    });

    expect(result).toEqual({ kind: 'input-blocked', acceptedEvents: 1, reason: 'Partial input dispatch' });
  });

  it('returns error when reading the clipboard fails', async () => {
    readText.mockImplementation(() => {
      throw new Error('clipboard locked');
    });

    const result = await injectIntoFocusedApp('text', {
      readText,
      writeText,
      simulatePaste,
      delay,
    });

    expect(result.kind).toBe('error');
    expect((result as Extract<InjectResult, { kind: 'error' }>).message).toContain('clipboard locked');
  });

  it('returns error when staging the clipboard fails', async () => {
    writeText.mockImplementation(() => {
      throw new Error('write failed');
    });

    const result = await injectIntoFocusedApp('text', {
      readText,
      writeText,
      simulatePaste,
      delay,
    });

    expect(result.kind).toBe('error');
    expect((result as Extract<InjectResult, { kind: 'error' }>).message).toContain('write failed');
  });

  it('returns error when paste dispatch throws', async () => {
    simulatePaste.mockImplementation(() => {
      throw new Error('SendInput failed');
    });

    const result = await injectIntoFocusedApp('text', {
      readText,
      writeText,
      simulatePaste,
      delay,
    });

    expect(result.kind).toBe('error');
    expect((result as Extract<InjectResult, { kind: 'error' }>).message).toContain('SendInput failed');
  });

  it('serializes concurrent injections so they do not interleave', async () => {
    const writeOrder: string[] = [];
    writeText.mockImplementation((text: string) => {
      writeOrder.push(text);
    });
    simulatePaste.mockImplementation(() => {
      writeOrder.push('paste');
      return { acceptedEvents: 4 };
    });

    const [first, second] = await Promise.all([
      injectIntoFocusedApp('first', { readText, writeText, simulatePaste, delay }),
      injectIntoFocusedApp('second', { readText, writeText, simulatePaste, delay }),
    ]);

    expect(first.kind).toBe('input-dispatched');
    expect(second.kind).toBe('input-dispatched');
    expect(writeOrder).toEqual(['first', 'paste', 'original clipboard', 'second', 'paste', 'original clipboard']);
  });

  it('copies the last transcript to the clipboard without synthetic input', () => {
    copyLastTranscriptToClipboard('saved text', { readText, writeText, simulatePaste, delay });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('saved text');
    expect(simulatePaste).not.toHaveBeenCalled();
  });
});
