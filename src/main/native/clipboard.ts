import koffi from 'koffi';
import { buildPasteStrategyEvents } from '../paste-strategy';
import type { PasteStrategy } from '../../types/ipc';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const INPUT_KEYBOARD = 1;

const INPUT_SIZE = 40; // sizeof(INPUT) on 64-bit Windows

const SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t cInputs, uint8_t * pInputs, int32_t cbSize)');
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');

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

export function simulatePaste(strategy: PasteStrategy = 'ctrl-v'): PasteDispatchResult {
  const events = buildPasteStrategyEvents(strategy);
  const inputs = Buffer.concat(events.map((event) => buildKeyboardInput(event.vk, event.flags)));

  const acceptedEvents = Number(SendInput(events.length, inputs, INPUT_SIZE));
  if (acceptedEvents < events.length) {
    const errorCode = Number(GetLastError());
    return { acceptedEvents, errorCode };
  }
  return { acceptedEvents };
}
