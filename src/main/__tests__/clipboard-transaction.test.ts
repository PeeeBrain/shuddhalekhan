import { describe, expect, it, mock } from 'bun:test';
import {
  captureClipboardSnapshot,
  restoreClipboardSnapshot,
  MAX_CLIPBOARD_SNAPSHOT_SIZE,
  type ClipboardIO,
} from '../clipboard-transaction';

function fakeClipboardIO(partial: Partial<ClipboardIO> & { formats?: string[] } = {}): ClipboardIO {
  return {
    availableFormats: () => partial.formats ?? [],
    readText: () => '',
    readHTML: () => '',
    readRTF: () => '',
    readImage: () => null,
    readBookmark: () => null,
    writeText: () => undefined,
    writeHTML: () => undefined,
    writeRTF: () => undefined,
    writeImage: () => undefined,
    writeBookmark: () => undefined,
    clear: () => undefined,
    ...partial,
  };
}

describe('captureClipboardSnapshot', () => {
  it('captures an empty clipboard as empty', () => {
    const io = fakeClipboardIO();

    const snapshot = captureClipboardSnapshot(io);

    expect(snapshot.wasEmpty).toBe(true);
    expect(snapshot.skippedFormats).toEqual([]);
  });

  it('captures plain text clipboard contents', () => {
    const io = fakeClipboardIO({
      formats: ['text/plain'],
      readText: () => 'original text',
    });

    const snapshot = captureClipboardSnapshot(io);

    expect(snapshot.wasEmpty).toBe(false);
    expect(snapshot.text).toBe('original text');
  });
});

describe('restoreClipboardSnapshot', () => {
  it('restores plain text to the clipboard', () => {
    const writeText = mock();
    const io = fakeClipboardIO({ writeText });

    restoreClipboardSnapshot({ wasEmpty: false, text: 'original text' }, io);

    expect(writeText).toHaveBeenCalledWith('original text');
  });

  it('restores an empty clipboard by clearing it', () => {
    const clear = mock();
    const io = fakeClipboardIO({ clear });

    restoreClipboardSnapshot({ wasEmpty: true, skippedFormats: [] }, io);

    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('restores a snapshot containing multiple formats', () => {
    const writeText = mock();
    const writeHTML = mock();
    const writeRTF = mock();
    const writeImage = mock();
    const writeBookmark = mock();
    const io = fakeClipboardIO({
      writeText,
      writeHTML,
      writeRTF,
      writeImage,
      writeBookmark,
    });

    restoreClipboardSnapshot(
      {
        wasEmpty: false,
        text: 'plain',
        html: '<p>html</p>',
        rtf: '{\\rtf1}',
        imagePng: Buffer.from('png'),
        bookmark: { title: 'Example', url: 'https://example.com' },
      },
      io
    );

    expect(writeText).toHaveBeenCalledWith('plain');
    expect(writeHTML).toHaveBeenCalledWith('<p>html</p>');
    expect(writeRTF).toHaveBeenCalledWith('{\\rtf1}');
    expect(writeImage).toHaveBeenCalledWith(Buffer.from('png'));
    expect(writeBookmark).toHaveBeenCalledWith('Example', 'https://example.com');
  });
});

describe('HTML clipboard contents', () => {
  it('capture and restore HTML with plain text fallback', () => {
    const writeHTML = mock();
    const io = fakeClipboardIO({
      formats: ['text/html', 'text/plain'],
      readHTML: () => '<p>hello</p>',
      readText: () => 'hello',
      writeHTML,
    });

    const snapshot = captureClipboardSnapshot(io);

    expect(snapshot.wasEmpty).toBe(false);
    expect(snapshot.html).toBe('<p>hello</p>');

    restoreClipboardSnapshot(snapshot, io);
    expect(writeHTML).toHaveBeenCalledWith('<p>hello</p>');
  });
});

describe('RTF clipboard contents', () => {
  it('capture and restore RTF', () => {
    const writeRTF = mock();
    const io = fakeClipboardIO({
      formats: ['Rich Text Format'],
      readRTF: () => '{\\rtf1 hello}',
      writeRTF,
    });

    const snapshot = captureClipboardSnapshot(io);

    expect(snapshot.wasEmpty).toBe(false);
    expect(snapshot.rtf).toBe('{\\rtf1 hello}');

    restoreClipboardSnapshot(snapshot, io);
    expect(writeRTF).toHaveBeenCalledWith('{\\rtf1 hello}');
  });
});

describe('Image clipboard contents', () => {
  it('capture and restore image data within the size limit', () => {
    const imageBuffer = Buffer.from('png-bytes');
    const writeImage = mock();
    const io = fakeClipboardIO({
      formats: ['image/png'],
      readImage: () => imageBuffer,
      writeImage,
    });

    const snapshot = captureClipboardSnapshot(io);

    expect(snapshot.wasEmpty).toBe(false);
    expect(snapshot.imagePng).toBe(imageBuffer);

    restoreClipboardSnapshot(snapshot, io);
    expect(writeImage).toHaveBeenCalledWith(imageBuffer);
  });
});

describe('Bookmark clipboard contents', () => {
  it('capture and restore bookmark data', () => {
    const writeBookmark = mock();
    const io = fakeClipboardIO({
      formats: ['text/uri-list'],
      readBookmark: () => ({ title: 'Example', url: 'https://example.com' }),
      writeBookmark,
    });

    const snapshot = captureClipboardSnapshot(io);

    expect(snapshot.wasEmpty).toBe(false);
    expect(snapshot.bookmark).toEqual({ title: 'Example', url: 'https://example.com' });

    restoreClipboardSnapshot(snapshot, io);
    expect(writeBookmark).toHaveBeenCalledWith('Example', 'https://example.com');
  });
});

describe('unsupported or skipped formats', () => {
  it('records unsupported formats as skipped without crashing', () => {
    const io = fakeClipboardIO({
      formats: ['text/plain', 'application/x-custom'],
      readText: () => 'hello',
    });

    const snapshot = captureClipboardSnapshot(io);

    expect(snapshot.text).toBe('hello');
    expect(snapshot.skippedFormats).toContain('application/x-custom');
  });

  it('deduplicates repeated unsupported formats', () => {
    const io = fakeClipboardIO({
      formats: ['text/plain', 'application/x-custom', 'application/x-custom'],
      readText: () => 'hello',
    });

    const snapshot = captureClipboardSnapshot(io);

    expect(snapshot.skippedFormats?.filter((format) => format === 'application/x-custom')).toHaveLength(1);
  });

  it('skips oversized image data but preserves text', () => {
    const io = fakeClipboardIO({
      formats: ['text/plain', 'image/png'],
      readText: () => 'hello',
      readImage: () => Buffer.alloc(100),
    });

    const snapshot = captureClipboardSnapshot(io, 10);

    expect(snapshot.text).toBe('hello');
    expect(snapshot.imagePng).toBeUndefined();
    expect(snapshot.skippedFormats).toContain('image/png');
  });

  it('exports a production size limit', () => {
    expect(MAX_CLIPBOARD_SNAPSHOT_SIZE).toBeGreaterThan(0);
  });
});
