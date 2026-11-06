import { spawn, type ChildProcess } from 'child_process';
import { accessSync, closeSync, constants, openSync, readFileSync, writeSync } from 'fs';
import koffi from 'koffi';

/**
 * Linux keyboard I/O through the kernel, so it works the same on X11 and
 * Wayland: hotkeys are read from evdev (/dev/input/event*), paste keystrokes
 * are written through a uinput virtual keyboard. Both need the user in the
 * `input` group (the deb/rpm udev rule opens /dev/uinput to that group).
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
const VK_TO_EVDEV = new Map([...EVDEV_TO_VK].filter(([code]) => code !== 96).map(([code, vk]) => [vk, code]));
// Paste strategies send generic VK_CONTROL/VK_SHIFT.
VK_TO_EVDEV.set(0x11, 29);
VK_TO_EVDEV.set(0x10, 42);

const EV_SYN = 0;
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
  // ponytail: one `cat` per keyboard keeps blocking evdev reads off libuv's
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
  try {
    ensureVirtualKeyboard(); // early, so the compositor has adopted it before the first paste
  } catch (error) {
    console.error('uinput unavailable; dictation will copy instead of paste:', error);
  }
  return () => {
    for (const reader of readers) {
      reader.removeAllListeners('close'); // a deliberate stop releases nothing
      reader.kill();
    }
  };
}

// ---- uinput virtual keyboard ----

const UI_SET_EVBIT = 0x40045564;
const UI_SET_KEYBIT = 0x40045565;
const UI_DEV_SETUP = 0x405c5503;
const UI_DEV_CREATE = 0x5501;
const BUS_VIRTUAL = 0x06;

let virtualKeyboardFd: number | null = null;

/**
 * Created once and kept open: compositors take a moment to adopt a new input
 * device, so creating it per paste would drop the first keystrokes.
 */
function ensureVirtualKeyboard(): number {
  if (virtualKeyboardFd !== null) return virtualKeyboardFd;
  const ioctl = koffi.load('libc.so.6').func('int ioctl(int fd, unsigned long request, ...)');
  const fd = openSync('/dev/uinput', constants.O_WRONLY | constants.O_NONBLOCK);
  const setup = Buffer.alloc(92); // struct uinput_setup
  setup.writeUInt16LE(BUS_VIRTUAL, 0);
  setup.write(VIRTUAL_KEYBOARD_NAME, 8, 'latin1');
  const created = ioctl(fd, UI_SET_EVBIT, 'int', EV_KEY) >= 0
    && [...new Set(VK_TO_EVDEV.values())].every((code) => ioctl(fd, UI_SET_KEYBIT, 'int', code) >= 0)
    && ioctl(fd, UI_DEV_SETUP, 'void *', setup) >= 0
    && ioctl(fd, UI_DEV_CREATE) >= 0;
  if (!created) {
    closeSync(fd); // otherwise every later paste retries and leaks another fd
    throw new Error('Could not create the uinput virtual keyboard.');
  }
  virtualKeyboardFd = fd;
  return fd;
}

function inputEvent(type: number, code: number, value: number): Buffer {
  const event = Buffer.alloc(INPUT_EVENT_SIZE);
  event.writeUInt16LE(type, 16);
  event.writeUInt16LE(code, 18);
  event.writeInt32LE(value, 20);
  return event;
}

/**
 * Sends VK key events through uinput. Codes are physical (QWERTY) positions,
 * so on remapped layouts such as Dvorak, Ctrl+V lands on that layout's key.
 * Returns how many events were written.
 */
export function sendVirtualKeys(events: Array<{ vk: number; keyUp: boolean }>): number {
  let fd: number;
  try {
    fd = ensureVirtualKeyboard();
  } catch (error) {
    console.error('uinput unavailable:', error);
    return 0;
  }
  let accepted = 0;
  const down = new Set<number>();
  const write = (code: number, value: number) =>
    writeSync(fd, Buffer.concat([inputEvent(EV_KEY, code, value), inputEvent(EV_SYN, 0, 0)]));
  try {
    for (const { vk, keyUp } of events) {
      const code = VK_TO_EVDEV.get(vk);
      if (code === undefined) break;
      write(code, keyUp ? 0 : 1);
      if (keyUp) down.delete(code);
      else down.add(code);
      accepted += 1;
    }
  } catch (error) {
    console.error('uinput write failed:', error);
  }
  // A short or failed sequence must not leave Ctrl/Shift held on the desktop.
  for (const code of down) {
    try { write(code, 0); } catch { /* device gone; nothing left to release */ }
  }
  return accepted;
}
