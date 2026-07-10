import { clipboard, nativeImage } from 'electron';
import { simulatePaste, getClipboardSequenceNumber } from './native/clipboard';
import { captureForegroundTarget } from './native/target';
import { resolvePasteStrategy } from './paste-strategy';
import { getConfig } from './config';
import type {
  ClipboardIO,
  ClipboardSnapshot,
  ForegroundInspector,
  InputSimulator,
  ClipboardMonitor,
  PasteStrategyResolver,
  PasteDispatchResult,
} from './clipboard-transaction-manager';
import type { DictationTargetSnapshot, PasteStrategy } from '../types/ipc';

const PLAIN_TEXT_FORMAT = 'text/plain';
const HTML_FORMAT = 'text/html';
const RTF_FORMAT = 'Rich Text Format';
const PNG_FORMAT = 'image/png';
const BOOKMARK_FORMATS = new Set([
  'text/uri-list',
  'URL Bookmark',
  'UniformResourceLocatorW',
]);
const BOOKMARK_SKIP_LABEL = 'URL Bookmark';

const SUPPORTED_FORMATS = new Set([
  PLAIN_TEXT_FORMAT,
  HTML_FORMAT,
  RTF_FORMAT,
  PNG_FORMAT,
  ...BOOKMARK_FORMATS,
]);

function stringByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function hasAnyFormat(formats: string[], candidates: Set<string>): boolean {
  return formats.some((format) => candidates.has(format));
}

export class ElectronClipboardAdapter implements ClipboardIO {
  constructor(private maxSize = 50 * 1024 * 1024) {}

  public captureSnapshot(): ClipboardSnapshot {
    const formats = clipboard.availableFormats();
    const skippedFormats = new Set<string>();
    for (const format of formats) {
      if (!SUPPORTED_FORMATS.has(format)) {
        skippedFormats.add(format);
      }
    }

    const snapshot: ClipboardSnapshot = { wasEmpty: true, skippedFormats: [] };
    let usedSize = 0;

    if (formats.includes(PLAIN_TEXT_FORMAT)) {
      const text = clipboard.readText();
      if (text) {
        snapshot.wasEmpty = false;
        snapshot.text = text;
        usedSize += stringByteLength(text);
      }
    }

    if (formats.includes(HTML_FORMAT)) {
      const html = clipboard.readHTML();
      if (html) {
        const size = stringByteLength(html);
        if (usedSize + size <= this.maxSize) {
          snapshot.wasEmpty = false;
          snapshot.html = html;
          usedSize += size;
        } else {
          skippedFormats.add(HTML_FORMAT);
        }
      }
    }

    if (formats.includes(RTF_FORMAT)) {
      const rtf = clipboard.readRTF();
      if (rtf) {
        const size = stringByteLength(rtf);
        if (usedSize + size <= this.maxSize) {
          snapshot.wasEmpty = false;
          snapshot.rtf = rtf;
          usedSize += size;
        } else {
          skippedFormats.add(RTF_FORMAT);
        }
      }
    }

    if (hasAnyFormat(formats, BOOKMARK_FORMATS)) {
      const bookmark = clipboard.readBookmark();
      if (bookmark && (bookmark.title || bookmark.url)) {
        const size = stringByteLength(bookmark.title) + stringByteLength(bookmark.url);
        if (usedSize + size <= this.maxSize) {
          snapshot.wasEmpty = false;
          snapshot.bookmark = bookmark;
          usedSize += size;
        } else {
          skippedFormats.add(BOOKMARK_SKIP_LABEL);
        }
      }
    }

    if (formats.includes(PNG_FORMAT)) {
      const image = clipboard.readImage();
      if (image && !image.isEmpty()) {
        const pngBuffer = image.toPNG();
        if (usedSize + pngBuffer.length <= this.maxSize) {
          snapshot.wasEmpty = false;
          snapshot.imagePng = pngBuffer;
        } else {
          skippedFormats.add(PNG_FORMAT);
        }
      }
    }

    snapshot.skippedFormats = [...skippedFormats];
    return snapshot;
  }

  public restoreSnapshot(snapshot: ClipboardSnapshot): void {
    if (snapshot.wasEmpty) {
      clipboard.clear();
      return;
    }

    if (snapshot.text !== undefined) {
      clipboard.writeText(snapshot.text);
    }
    if (snapshot.html !== undefined) {
      clipboard.writeHTML(snapshot.html);
    }
    if (snapshot.rtf !== undefined) {
      clipboard.writeRTF(snapshot.rtf);
    }
    if (snapshot.imagePng !== undefined) {
      clipboard.writeImage(nativeImage.createFromBuffer(snapshot.imagePng));
    }
    if (snapshot.bookmark !== undefined) {
      clipboard.writeBookmark(snapshot.bookmark.title, snapshot.bookmark.url);
    }
  }

  public writeText(text: string): void {
    clipboard.writeText(text);
  }
}

export class Win32InputSimulator implements InputSimulator {
  public simulatePaste(strategy: PasteStrategy): PasteDispatchResult {
    return simulatePaste(strategy);
  }
}

export class Win32ForegroundInspector implements ForegroundInspector {
  public captureTarget(): DictationTargetSnapshot | null {
    return captureForegroundTarget();
  }
}

export class Win32ClipboardMonitor implements ClipboardMonitor {
  public getSequenceNumber(): number {
    return getClipboardSequenceNumber();
  }
}

export class ConfigPasteStrategyResolver implements PasteStrategyResolver {
  public resolveStrategy(executablePath: string | null): PasteStrategy {
    const config = getConfig().pasteStrategy;
    return resolvePasteStrategy(executablePath, config);
  }
}
