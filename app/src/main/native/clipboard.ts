import koffi from 'koffi';
import { buildPasteStrategyEvents } from '../paste-strategy';
import type { PasteStrategy } from '../../types/ipc';
import { openX11ClipboardMonitor } from './x11-clipboard';
import { simulateX11Paste } from './x11-paste';

const INPUT_KEYBOARD = 1;

const INPUT_SIZE = 40; // sizeof(INPUT) on 64-bit Windows

let win32Api: ReturnType<typeof loadWin32Api> | null = null;
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
  };
}

function win32() {
  win32Api ??= loadWin32Api();
  return win32Api;
}

export interface PasteDispatchResult {
  acceptedEvents: number;
  errorCode?: number;
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
    if (process.platform !== 'linux' || process.env.XDG_SESSION_TYPE === 'wayland'
      || process.env.WAYLAND_DISPLAY || !process.env.DISPLAY) {
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
    if (process.platform === 'linux' && process.env.DISPLAY
      && process.env.XDG_SESSION_TYPE !== 'wayland' && !process.env.WAYLAND_DISPLAY) {
      return simulateX11Paste(strategy);
    }
    return { acceptedEvents: 0 };
  }
  const { SendInput, GetLastError } = win32();
  const inputs = Buffer.concat(events.map((event) => buildKeyboardInput(event.vk, event.flags)));

  const acceptedEvents = Number(SendInput(events.length, inputs, INPUT_SIZE));
  if (acceptedEvents < events.length) {
    const errorCode = Number(GetLastError());
    return { acceptedEvents, errorCode };
  }
  return { acceptedEvents };
}
