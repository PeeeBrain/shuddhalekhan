import { spawn, type ChildProcess } from 'child_process';
import { accessSync, constants, readFileSync } from 'fs';

/**
 * Raw keyboard observation is a fallback for desktops without working portal
 * shortcuts or X11 grabs. It needs input-group access and cannot suppress
 * the shortcut in the focused app.
 *
 * Key codes are translated to Windows virtual-key codes so the shared
 * shortcut model and KeyboardHook state machine stay platform-neutral.
 */

// linux/input-event-codes.h → Windows VK
const EVDEV_TO_VK = new Map<number, number>([
  [1, 0x1b], [14, 0x08], [15, 0x09], [28, 0x0d], [57, 0x20], [96, 0x0d],
  [12, 0xbd], [13, 0xbb], [26, 0xdb], [27, 0xdd], [39, 0xba], [40, 0xde], [41, 0xc0],
  [43, 0xdc], [51, 0xbc], [52, 0xbe], [53, 0xbf], [86, 0xe2],
  [29, 0xa2], [97, 0xa3], [42, 0xa0], [54, 0xa1], [56, 0xa4], [100, 0xa5], [125, 0x5b], [126, 0x5c],
  [102, 0x24], [103, 0x26], [104, 0x21], [105, 0x25], [106, 0x27], [107, 0x23], [108, 0x28],
  [109, 0x22], [110, 0x2d], [111, 0x2e],
  [11, 0x30], ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((code, i) => [code, 0x31 + i] as [number, number]),
  ...'QWERTYUIOP'.split('').map((c, i) => [16 + i, c.charCodeAt(0)] as [number, number]),
  ...'ASDFGHJKL'.split('').map((c, i) => [30 + i, c.charCodeAt(0)] as [number, number]),
  ...'ZXCVBNM'.split('').map((c, i) => [44 + i, c.charCodeAt(0)] as [number, number]),
  ...Array.from({ length: 10 }, (_, i) => [59 + i, 0x70 + i] as [number, number]), // F1–F10
  [87, 0x7a], [88, 0x7b], // F11, F12
  ...Array.from({ length: 12 }, (_, i) => [183 + i, 0x7c + i] as [number, number]), // F13–F24
]);

const EV_KEY = 1;
const EV_REP_BIT = 1 << 20;
const INPUT_EVENT_SIZE = 24; // struct input_event on 64-bit
const VIRTUAL_KEYBOARD_NAME = 'Shuddhalekhan virtual keyboard';

export function evdevToVirtualKey(code: number): number | undefined {
  return EVDEV_TO_VK.get(code);
}


/** Keyboards from /proc/bus/input/devices: `kbd` handler with key repeat (skips power buttons and our own device). */
export function parseKeyboardDevices(procDevices: string): string[] {
  return procDevices.split(/\n\s*\n/).flatMap((block) => {
    if (block.includes(VIRTUAL_KEYBOARD_NAME)) return [];
    const handlers = /^H: Handlers=(.*)$/m.exec(block)?.[1].split(/\s+/) ?? [];
    const ev = Number.parseInt(/^B: EV=([0-9a-f]+)$/m.exec(block)?.[1] ?? '0', 16);
    const event = handlers.find((handler) => /^event\d+$/.test(handler));
    return handlers.includes('kbd') && ev & EV_REP_BIT && event ? [`/dev/input/${event}`] : [];
  });
}

/** Feeds a byte stream of input_event structs, keeping partial events across chunks. */
export function createInputEventParser(onKey: (vkCode: number, isDown: boolean) => void): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let offset = 0;
    for (; offset + INPUT_EVENT_SIZE <= pending.length; offset += INPUT_EVENT_SIZE) {
      if (pending.readUInt16LE(offset + 16) !== EV_KEY) continue;
      const vkCode = EVDEV_TO_VK.get(pending.readUInt16LE(offset + 18));
      if (vkCode !== undefined) onKey(vkCode, pending.readInt32LE(offset + 20) !== 0); // 1 down, 2 repeat, 0 up
    }
    pending = pending.subarray(offset);
  };
}

/** Starts reading every keyboard; returns a stop function. Throws when no keyboard is readable. */
export function startEvdevKeyboardReader(onKey: (vkCode: number, isDown: boolean) => void): () => void {
  const devices = parseKeyboardDevices(readFileSync('/proc/bus/input/devices', 'utf8')).filter((path) => {
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (devices.length === 0) {
    throw new Error('No readable keyboard found. Add your user to the "input" group (sudo usermod -aG input $USER), then restart your computer. Logging out is often not enough because the desktop session keeps the old groups.');
  }
  // shortcut: one `cat` per keyboard keeps blocking evdev reads off libuv's
  // small threadpool without a native poll binding. Keyboards plugged in
  // later are picked up on the next app start.
  // Which keyboards hold each key: a key is released only when the last one
  // lets go, so the same key held on two keyboards stays down.
  const holders = new Map<number, Set<string>>();
  const release = (vkCode: number, path: string) => {
    const held = holders.get(vkCode);
    if (!held?.delete(path) || held.size > 0) return;
    holders.delete(vkCode);
    onKey(vkCode, false);
  };
  const readers: ChildProcess[] = devices.map((path) => {
    const child = spawn('cat', [path], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout?.on('data', createInputEventParser((vkCode, isDown) => {
      if (!isDown) return release(vkCode, path);
      holders.set(vkCode, (holders.get(vkCode) ?? new Set()).add(path));
      onKey(vkCode, true);
    }));
    child.on('error', (error) => console.error(`Failed to read ${path}:`, error));
    // An unplugged keyboard never sends its key-ups; release what it held so a
    // shortcut does not stay down.
    child.on('close', () => {
      for (const vkCode of [...holders.keys()]) release(vkCode, path);
    });
    return child;
  });
  return () => {
    for (const reader of readers) {
      reader.removeAllListeners('close'); // a deliberate stop releases nothing
      reader.kill();
    }
  };
}
