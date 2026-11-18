import koffi from 'koffi';
import { buildPasteStrategyEvents } from '../paste-strategy';
import type { PasteStrategy } from '../../types/ipc';
import { openX11ClipboardMonitor } from './x11-clipboard';
import { simulateX11Paste } from './x11-paste';
import { classifyDesktopSession } from '../dictation-delivery-policy';
import type { PasteDispatchResult } from '../paste-strategy';
import type { TransientWrite } from '../clipboard-transaction-manager';

const INPUT_KEYBOARD = 1;

const INPUT_SIZE = 40; // sizeof(INPUT) on 64-bit Windows

const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x0002;
const HWND_MESSAGE = -3;
const OPEN_CLIPBOARD_ATTEMPTS = 5;
// Registered formats Windows reads to keep an entry out of Win+V history and cloud sync.
// https://learn.microsoft.com/windows/win32/dataxchg/clipboard-formats#cloud-clipboard-and-clipboard-history-formats
const EXCLUSION_FORMATS = ['CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard'];
const DWORD_ZERO = Buffer.alloc(4);

let win32Api: ReturnType<typeof loadWin32Api> | null = null;
let clipboardOwner: unknown = null;
let x11Monitor: ReturnType<typeof openX11ClipboardMonitor> | null = null;
let x11Sequence = 0;
let x11Observed = 0;

/** Loaded on first use so importing this module never touches user32.dll off Windows. */
function loadWin32Api() {
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  return {
    SendInput: user32.func('uint32_t __stdcall SendInput(uint32_t cInputs, uint8_t * pInputs, int32_t cbSize)'),
    GetLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
    GetClipboardSequenceNumber: user32.func('uint32_t __stdcall GetClipboardSequenceNumber()'),
    CreateWindowExW: user32.func('void * __stdcall CreateWindowExW(uint32_t dwExStyle, str16 lpClassName, str16 lpWindowName, uint32_t dwStyle, int x, int y, int nWidth, int nHeight, intptr_t hWndParent, void *hMenu, void *hInstance, void *lpParam)'),
    OpenClipboard: user32.func('int32_t __stdcall OpenClipboard(void *hWndNewOwner)'),
    EmptyClipboard: user32.func('int32_t __stdcall EmptyClipboard()'),
    SetClipboardData: user32.func('void * __stdcall SetClipboardData(uint32_t uFormat, void *hMem)'),
    CloseClipboard: user32.func('int32_t __stdcall CloseClipboard()'),
    RegisterClipboardFormatW: user32.func('uint32_t __stdcall RegisterClipboardFormatW(str16 lpszFormat)'),
    GlobalAlloc: kernel32.func('void * __stdcall GlobalAlloc(uint32_t uFlags, uintptr_t dwBytes)'),
    GlobalLock: kernel32.func('void * __stdcall GlobalLock(void *hMem)'),
    GlobalUnlock: kernel32.func('int32_t __stdcall GlobalUnlock(void *hMem)'),
    GlobalFree: kernel32.func('void * __stdcall GlobalFree(void *hMem)'),
    RtlMoveMemory: kernel32.func('void __stdcall RtlMoveMemory(void *Destination, const uint8_t *Source, uintptr_t Length)'),
    Sleep: kernel32.func('void __stdcall Sleep(uint32_t dwMilliseconds)'),
  };
}

type Win32Api = ReturnType<typeof loadWin32Api>;

function win32Failure(api: Win32Api, call: string): Error {
  return new Error(`${call} failed (Win32 error ${Number(api.GetLastError())})`);
}

/** Copies bytes into a movable global block and hands it to the open clipboard. */
function setClipboardBytes(api: Win32Api, format: number, bytes: Buffer): void {
  const memory = api.GlobalAlloc(GMEM_MOVEABLE, bytes.length);
  if (!memory) throw win32Failure(api, 'GlobalAlloc');
  const target = api.GlobalLock(memory);
  if (!target) {
    const error = win32Failure(api, 'GlobalLock');
    api.GlobalFree(memory);
    throw error;
  }
  api.RtlMoveMemory(target, bytes, bytes.length);
  api.GlobalUnlock(memory);
  // On success the system owns the block; on failure it is still ours to free.
  if (!api.SetClipboardData(format, memory)) {
    const error = win32Failure(api, 'SetClipboardData');
    api.GlobalFree(memory);
    throw error;
  }
}

/**
 * Stages paste text that Windows keeps out of clipboard history (Win+V) and cloud sync, only while
 * the clipboard still has `expectedSequence`. Deliberate copies go through Electron's ordinary write.
 * Throws only before touching the clipboard. Errors and logs never include the text.
 */
export function writeTransientClipboardText(text: string, expectedSequence: number): TransientWrite {
  const api = win32();
  const formats = EXCLUSION_FORMATS.map((name) => {
    const format = Number(api.RegisterClipboardFormatW(name));
    if (!format) throw win32Failure(api, 'RegisterClipboardFormatW');
    return format;
  });
  // SetClipboardData needs a real owner: EmptyClipboard after OpenClipboard(NULL) leaves none.
  // A message-only window on the main thread is pumped by Electron's message loop.
  clipboardOwner ??= api.CreateWindowExW(0, 'STATIC', null, 0, 0, 0, 0, 0, HWND_MESSAGE, null, null, null);
  if (!clipboardOwner) throw win32Failure(api, 'CreateWindowExW');

  // Same bounded retry Chromium uses when another app briefly holds the clipboard.
  for (let attempt = 1; !api.OpenClipboard(clipboardOwner); attempt++) {
    if (attempt === OPEN_CLIPBOARD_ATTEMPTS) throw win32Failure(api, 'OpenClipboard');
    api.Sleep(5);
  }
  try {
    // Checked under the lock, so a copy made after the snapshot is never overwritten.
    if (Number(api.GetClipboardSequenceNumber()) !== expectedSequence) return 'changed';
    if (!api.EmptyClipboard()) throw win32Failure(api, 'EmptyClipboard');
    try {
      // Exclusions go first so a failed write can never publish unmarked text to history.
      for (const format of formats) setClipboardBytes(api, format, DWORD_ZERO);
      setClipboardBytes(api, CF_UNICODETEXT, Buffer.from(`${text}\0`, 'utf16le'));
    }
    catch (error) {
      console.warn('Transient clipboard write failed after emptying the clipboard:', error);
      return 'cleared';
    }
    return 'staged';
  }
  finally {
    api.CloseClipboard();
  }
}

function win32() {
  win32Api ??= loadWin32Api();
  return win32Api;
}

function buildKeyboardInput(vk: number, flags: number): Buffer {
  const buf = Buffer.alloc(INPUT_SIZE);
  buf.writeUInt32LE(INPUT_KEYBOARD, 0);
  buf.writeUInt16LE(vk, 8);
  buf.writeUInt16LE(0, 10); // wScan
  buf.writeUInt32LE(flags, 12);
  buf.writeUInt32LE(0, 16); // time
  buf.writeBigUInt64LE(BigInt(0), 24); // dwExtraInfo
  return buf;
}

export function getClipboardSequenceNumber(): number {
  if (process.platform !== 'win32') {
    if (classifyDesktopSession(process.platform, process.env) !== 'x11') {
      throw new Error('Clipboard ownership tracking is unavailable on this desktop.');
    }
    if (!x11Monitor) {
      x11Monitor = openX11ClipboardMonitor();
      x11Observed = 0;
      x11Sequence += 1;
      process.once('exit', () => x11Monitor?.close());
    }
    try {
      const observed = x11Monitor.sequence();
      x11Sequence += observed - x11Observed;
      x11Observed = observed;
      return x11Sequence;
    }
    catch (error) {
      x11Monitor.close();
      x11Monitor = null;
      throw error;
    }
  }
  // GetClipboardSequenceNumber returns a uint32_t value. Windows documents it as
  // "monotonically increasing", but it can wrap around after ~4 billion writes.
  // Callers compare snapshots with simple equality, so a wrap to the same value
  // would silently look like "no conflict". This is acceptable in practice for a
  // desktop dictation app, but callers should not rely on strict ordering across
  // wrap-around.
  return Number(win32().GetClipboardSequenceNumber());
}

export function simulatePaste(strategy: PasteStrategy = 'ctrl-v'): PasteDispatchResult {
  const events = buildPasteStrategyEvents(strategy);
  if (process.platform !== 'win32') {
    if (classifyDesktopSession(process.platform, process.env) === 'x11') {
      return simulateX11Paste(strategy);
    }
    return { acceptedEvents: 0 };
  }
  const { SendInput, GetLastError } = win32();
  const inputs = Buffer.concat(events.map((event) => buildKeyboardInput(event.vk, event.up ? 2 : 0)));

  const acceptedEvents = Number(SendInput(events.length, inputs, INPUT_SIZE));
  if (acceptedEvents < events.length) {
    const errorCode = Number(GetLastError());
    return { acceptedEvents, errorCode };
  }
  return { acceptedEvents };
}
