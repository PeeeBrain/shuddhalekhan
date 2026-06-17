import { clipboard, nativeImage } from 'electron';

export interface ClipboardSnapshot {
  wasEmpty: boolean;
  text?: string;
  html?: string;
  rtf?: string;
  imagePng?: Buffer;
  bookmark?: {
    title: string;
    url: string;
  };
  skippedFormats?: string[];
}

export const MAX_CLIPBOARD_SNAPSHOT_SIZE = 50 * 1024 * 1024; // 50 MB

export interface ClipboardIO {
  availableFormats: () => string[];
  readText: () => string;
  readHTML: () => string;
  readRTF: () => string;
  readImage: () => Buffer | null;
  readBookmark: () => { title: string; url: string } | null;
  writeText: (text: string) => void;
  writeHTML: (html: string) => void;
  writeRTF: (rtf: string) => void;
  writeImage: (buffer: Buffer) => void;
  writeBookmark: (title: string, url: string) => void;
  clear: () => void;
}

const SUPPORTED_FORMATS = new Set([
  'text/plain',
  'text/html',
  'Rich Text Format',
  'image/png',
  'text/uri-list',
]);

function stringByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function captureClipboardSnapshot(
  deps: ClipboardIO,
  maxSize = MAX_CLIPBOARD_SNAPSHOT_SIZE
): ClipboardSnapshot {
  const formats = deps.availableFormats();
  const skippedFormats: string[] = [];
  for (const format of formats) {
    if (!SUPPORTED_FORMATS.has(format)) {
      skippedFormats.push(format);
    }
  }

  const snapshot: ClipboardSnapshot = { wasEmpty: true, skippedFormats };
  let usedSize = 0;

  const text = deps.readText();
  if (text) {
    snapshot.wasEmpty = false;
    snapshot.text = text;
    usedSize += stringByteLength(text);
  }

  const html = deps.readHTML();
  if (html) {
    const size = stringByteLength(html);
    if (usedSize + size <= maxSize) {
      snapshot.wasEmpty = false;
      snapshot.html = html;
      usedSize += size;
    } else {
      skippedFormats.push('text/html');
    }
  }

  const rtf = deps.readRTF();
  if (rtf) {
    const size = stringByteLength(rtf);
    if (usedSize + size <= maxSize) {
      snapshot.wasEmpty = false;
      snapshot.rtf = rtf;
      usedSize += size;
    } else {
      skippedFormats.push('Rich Text Format');
    }
  }

  const bookmark = deps.readBookmark();
  if (bookmark) {
    const size = stringByteLength(bookmark.title) + stringByteLength(bookmark.url);
    if (usedSize + size <= maxSize) {
      snapshot.wasEmpty = false;
      snapshot.bookmark = bookmark;
      usedSize += size;
    } else {
      skippedFormats.push('text/uri-list');
    }
  }

  const image = deps.readImage();
  if (image) {
    if (usedSize + image.length <= maxSize) {
      snapshot.wasEmpty = false;
      snapshot.imagePng = image;
    } else {
      skippedFormats.push('image/png');
    }
  }

  return snapshot;
}

export function restoreClipboardSnapshot(snapshot: ClipboardSnapshot, deps: ClipboardIO): void {
  if (snapshot.wasEmpty) {
    deps.clear();
    return;
  }
  if (snapshot.text !== undefined) {
    deps.writeText(snapshot.text);
  }
  if (snapshot.html !== undefined) {
    deps.writeHTML(snapshot.html);
  }
  if (snapshot.rtf !== undefined) {
    deps.writeRTF(snapshot.rtf);
  }
  if (snapshot.imagePng !== undefined) {
    deps.writeImage(snapshot.imagePng);
  }
  if (snapshot.bookmark !== undefined) {
    deps.writeBookmark(snapshot.bookmark.title, snapshot.bookmark.url);
  }
}

export function createNativeClipboardIO(): ClipboardIO {
  return {
    availableFormats: () => clipboard.availableFormats(),
    readText: () => clipboard.readText(),
    readHTML: () => clipboard.readHTML(),
    readRTF: () => clipboard.readRTF(),
    readImage: () => {
      const image = clipboard.readImage();
      return image.isEmpty() ? null : image.toPNG();
    },
    readBookmark: () => {
      const bookmark = clipboard.readBookmark();
      return bookmark.title || bookmark.url ? bookmark : null;
    },
    writeText: (text) => clipboard.writeText(text),
    writeHTML: (html) => clipboard.writeHTML(html),
    writeRTF: (rtf) => clipboard.writeRTF(rtf),
    writeImage: (buffer) => clipboard.writeImage(nativeImage.createFromBuffer(buffer)),
    writeBookmark: (title, url) => clipboard.writeBookmark(title, url),
    clear: () => clipboard.clear(),
  };
}
