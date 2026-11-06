import { createHash } from 'crypto';
// Namespace import: resolved only on use, so modules importing this without an
// Electron runtime (Windows tests) don't fail on a missing named export.
import * as electron from 'electron';
import koffi from 'koffi';
import { buildPasteStrategyEvents } from '../paste-strategy';
import type { PasteStrategy } from '../../types/ipc';
import { sendVirtualKeys } from './linux-input';

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;

const INPUT_SIZE = 40; // sizeof(INPUT) on 64-bit Windows

let win32Api: ReturnType<typeof loadWin32Api> | null = null;

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
    // ponytail: X11/Wayland expose no change counter; a text hash detects a
    // user copy during paste but misses image-only changes.
    return createHash('sha1').update(electron.clipboard.readText()).digest().readUInt32LE(0);
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
    return {
      acceptedEvents: sendVirtualKeys(events.map((event) => ({ vk: event.vk, keyUp: (event.flags & KEYEVENTF_KEYUP) !== 0 }))),
    };
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
