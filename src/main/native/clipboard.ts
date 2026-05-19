import koffi from 'koffi';

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;

// Virtual key codes
const VK_CONTROL = 0x11;
const VK_V = 0x56;

const INPUT_SIZE = 40; // sizeof(INPUT) on 64-bit Windows

let sendInput: ((cInputs: number, pInputs: Buffer, cbSize: number) => number) | null = null;

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

export function simulatePaste(): void {
  if (process.platform !== 'win32') {
    throw new Error('Paste simulation is not available on this platform yet.');
  }

  const inputs = Buffer.concat([
    buildKeyboardInput(VK_CONTROL, 0),
    buildKeyboardInput(VK_V, 0),
    buildKeyboardInput(VK_V, KEYEVENTF_KEYUP),
    buildKeyboardInput(VK_CONTROL, KEYEVENTF_KEYUP),
  ]);

  getSendInput()(4, inputs, INPUT_SIZE);
}

function getSendInput(): (cInputs: number, pInputs: Buffer, cbSize: number) => number {
  if (!sendInput) {
    const user32 = koffi.load('user32.dll');
    sendInput = user32.func('uint32_t __stdcall SendInput(uint32_t cInputs, uint8_t * pInputs, int32_t cbSize)') as (
      cInputs: number,
      pInputs: Buffer,
      cbSize: number
    ) => number;
  }

  return sendInput;
}
