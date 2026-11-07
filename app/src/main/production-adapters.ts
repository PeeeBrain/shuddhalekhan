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
const RTF_FORMATS = new Set(['text/rtf', 'Rich Text Format']);
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
  ...RTF_FORMATS,
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
        const size = stringByteLength(text);
        if (size <= this.maxSize) {
          snapshot.wasEmpty = false;
          snapshot.text = text;
          usedSize += size;
        } else {
          skippedFormats.add(PLAIN_TEXT_FORMAT);
        }
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

    if (hasAnyFormat(formats, RTF_FORMATS)) {
      const rtf = clipboard.readRTF();
      if (rtf) {
        const size = stringByteLength(rtf);
        if (usedSize + size <= this.maxSize) {
          snapshot.wasEmpty = false;
          snapshot.rtf = rtf;
          usedSize += size;
        } else {
          skippedFormats.add('text/rtf');
        }
      }
    }

    if (hasAnyFormat(formats, BOOKMARK_FORMATS)) {
      const bookmark = clipboard.readBookmark();
      if (bookmark && (bookmark.title || bookmark.url)) {
        const size = stringByteLength(bookmark.title) + stringByteLength(bookmark.url);
        if (usedSize + size <= this.maxSize
          && (snapshot.text === undefined || snapshot.text === bookmark.url)) {
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

    // Each write replaces the clipboard; restore all representations together.
    clipboard.write({
      text: snapshot.text ?? snapshot.bookmark?.url,
      html: snapshot.html,
      rtf: snapshot.rtf,
      image: snapshot.imagePng === undefined ? undefined : nativeImage.createFromBuffer(snapshot.imagePng),
      bookmark: snapshot.bookmark?.title,
    });
  }

  public writeText(text: string): void {
    clipboard.writeText(text);
  }
}

export class NativeInputSimulator implements InputSimulator {
  public simulatePaste(strategy: PasteStrategy): PasteDispatchResult {
    return simulatePaste(strategy);
  }
}

export class NativeForegroundInspector implements ForegroundInspector {
  public captureTarget(): DictationTargetSnapshot | null {
    return captureForegroundTarget();
  }
}

export class NativeClipboardMonitor implements ClipboardMonitor {
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
