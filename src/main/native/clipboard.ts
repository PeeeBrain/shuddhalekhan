import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;

// Virtual key codes
const VK_CONTROL = 0x11;
const VK_V = 0x56;

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

export function simulatePaste(): PasteDispatchResult {
  const inputs = Buffer.concat([
    buildKeyboardInput(VK_CONTROL, 0),
    buildKeyboardInput(VK_V, 0),
    buildKeyboardInput(VK_V, KEYEVENTF_KEYUP),
    buildKeyboardInput(VK_CONTROL, KEYEVENTF_KEYUP),
  ]);

  const acceptedEvents = Number(SendInput(4, inputs, INPUT_SIZE));
  if (acceptedEvents < 4) {
    const errorCode = Number(GetLastError());
    return { acceptedEvents, errorCode };
  }
  return { acceptedEvents };
}
