import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

installElectronMock();
mock.module('electron-store', () => ({ default: class {
  values: Record<string, unknown>;
  constructor({ defaults }: { defaults: Record<string, unknown> }) { this.values = { ...defaults }; }
  get(key: string) { return this.values[key]; }
  set(key: string, value: unknown) { this.values[key] = value; }
} }));
const { ElectronClipboardAdapter } = await import('../production-adapters');

describe('clipboard preservation', () => {
  beforeEach(resetElectronMock);

  it('restores rich text and its plain representation in one clipboard replacement', () => {
    electronMock.clipboard.availableFormats.mockReturnValue(['text/plain', 'text/html', 'text/rtf']);
    electronMock.clipboard.readText.mockReturnValue('hello');
    electronMock.clipboard.readHTML.mockReturnValue('<b>hello</b>');
    electronMock.clipboard.readRTF.mockReturnValue('{\\rtf1 hello}');
    const adapter = new ElectronClipboardAdapter();
    const snapshot = adapter.captureSnapshot();

    adapter.restoreSnapshot(snapshot);

    expect(electronMock.clipboard.write).toHaveBeenCalledTimes(1);
    expect(electronMock.clipboard.write).toHaveBeenCalledWith({
      text: 'hello', html: '<b>hello</b>', rtf: '{\\rtf1 hello}',
      image: undefined, bookmark: undefined,
    });
    expect(electronMock.clipboard.writeText).not.toHaveBeenCalled();
    expect(electronMock.clipboard.writeHTML).not.toHaveBeenCalled();
    expect(electronMock.clipboard.writeRTF).not.toHaveBeenCalled();
  });

  it('marks oversized plain text as unpreservable instead of staging over it', () => {
    electronMock.clipboard.availableFormats.mockReturnValue(['text/plain']);
    electronMock.clipboard.readText.mockReturnValue('too long');
    const snapshot = new ElectronClipboardAdapter(3).captureSnapshot();
    expect(snapshot.text).toBeUndefined();
    expect(snapshot.skippedFormats).toEqual(['text/plain']);
  });
});
