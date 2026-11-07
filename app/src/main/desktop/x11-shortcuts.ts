import { readFileSync } from 'fs';
import { connect, type Socket } from 'net';
import { homedir } from 'os';
import { join } from 'path';
import type { RecordingIntent, ShortcutBinding, ShortcutModifier } from '../../types/ipc';
import { formatBinding } from '../../shared/shortcut-bindings';
import type { LinuxShortcutBackend, LinuxShortcutBindings, LinuxShortcutEvents, LinuxShortcutTriggers } from './linux-shortcuts';

/**
 * X11 global shortcuts through passive key grabs on the root window, spoken
 * directly over the local X socket. The X server reports each chord press and
 * release to us and keeps it from the focused app; a chord another client
 * already grabbed fails with BadAccess, which surfaces as a conflict.
 *
 * Keys are resolved through the server's own keymap, so a binding means the
 * key that types it (Ctrl+V on Dvorak grabs the Dvorak V key), and modifiers
 * use whichever Mod row their keys sit on. A key the layout lacks stays
 * unassigned rather than guessing a physical position.
 */

const LOCK = 2;
const ANY_KEY = 0;
const ANY_MODIFIER = 0x8000;
const KEY_PRESS = 2;
const KEY_RELEASE = 3;
const NUM_LOCK = 0xff7f;
// Left and right keysyms per modifier (X11/keysymdef.h).
const MODIFIER_KEYSYMS: Record<ShortcutModifier, number[]> = {
  shift: [0xffe1, 0xffe2], ctrl: [0xffe3, 0xffe4], alt: [0xffe9, 0xffea], win: [0xffeb, 0xffec],
};
/** Windows VK of each supported ordinary key → keysyms that identify it on the key's base level. */
const ORDINARY_KEYSYMS = new Map<number, number[]>([
  [0x08, [0xff08]], [0x09, [0xff09]], [0x0d, [0xff0d]], [0x1b, [0xff1b]], [0x20, [0x20]],
  [0x21, [0xff55]], [0x22, [0xff56]], [0x23, [0xff57]], [0x24, [0xff50]],
  [0x25, [0xff51]], [0x26, [0xff52]], [0x27, [0xff53]], [0x28, [0xff54]], [0x2d, [0xff63]], [0x2e, [0xffff]],
  ...Array.from({ length: 10 }, (_, i) => [0x30 + i, [0x30 + i]] as [number, number[]]),
  ...Array.from({ length: 26 }, (_, i) => [0x41 + i, [0x61 + i, 0x41 + i]] as [number, number[]]),
  ...Array.from({ length: 24 }, (_, i) => [0x70 + i, [0xffbe + i]] as [number, number[]]), // F1–F24
  [0xba, [0x3b]], [0xbb, [0x3d]], [0xbc, [0x2c]], [0xbd, [0x2d]], [0xbe, [0x2e]], [0xbf, [0x2f]],
  [0xc0, [0x60]], [0xdb, [0x5b]], [0xdc, [0x5c]], [0xdd, [0x5d]], [0xde, [0x27]], [0xe2, [0x3c]],
]);

/** The server's keymap, from GetKeyboardMapping and GetModifierMapping. */
export interface X11Keymap {
  /** Base keysym (group 1, unshifted) of each keycode. */
  keysyms: Map<number, number>;
  /** Keycodes on each modifier row: Shift, Lock, Control, Mod1–Mod5 (mask bit = 1 << row). */
  modifiers: number[][];
}

export interface X11Grab {
  intent: RecordingIntent;
  keycode: number;
  modifiers: number;
}

const keycodesOf = (keymap: X11Keymap, keysyms: number[]) =>
  [...keymap.keysyms].filter(([, keysym]) => keysyms.includes(keysym)).map(([keycode]) => keycode);
const maskOf = (keymap: X11Keymap, keycodes: number[]) =>
  keymap.modifiers.reduce((mask, row, i) => (row.some((keycode) => keycodes.includes(keycode)) ? mask | (1 << i) : mask), 0);
/** Lock states that must not disable a chord: Caps Lock and whichever row holds Num Lock. */
const ignoredLocks = (keymap: X11Keymap) => LOCK | maskOf(keymap, keycodesOf(keymap, [NUM_LOCK]));

/** A modifier's keys that actually set its mask bit, or null when it has no single usable bit. */
function resolveModifier(keymap: X11Keymap, modifier: ShortcutModifier): { keycodes: number[]; mask: number } | null {
  const keycodes = keycodesOf(keymap, MODIFIER_KEYSYMS[modifier]).filter((keycode) => maskOf(keymap, [keycode]) !== 0);
  const mask = maskOf(keymap, keycodes);
  // Left and right on different rows would need either bit, which one grab cannot express.
  return mask !== 0 && (mask & (mask - 1)) === 0 ? { keycodes, mask } : null;
}

/**
 * Key + modifier-mask grabs that fire the chord whichever of its keys is
 * pressed last, against the server's current keymap. Empty when the layout
 * cannot express the chord: the key or a modifier is missing, or two
 * modifiers (or a modifier and Num Lock) share one mask bit.
 */
export function x11Grabs(intent: RecordingIntent, binding: ShortcutBinding, keymap: X11Keymap): X11Grab[] {
  const modifiers: Array<{ keycodes: number[]; mask: number }> = [];
  let mask = 0;
  for (const name of binding.modifiers) {
    const modifier = resolveModifier(keymap, name);
    if (!modifier || modifier.mask & (mask | ignoredLocks(keymap))) return [];
    mask |= modifier.mask;
    modifiers.push(modifier);
  }
  if (binding.keyCode !== null) {
    return keycodesOf(keymap, ORDINARY_KEYSYMS.get(binding.keyCode) ?? []).map((keycode) => ({ intent, keycode, modifiers: mask }));
  }
  return modifiers.flatMap((modifier) => modifier.keycodes.map((keycode) => ({ intent, keycode, modifiers: mask & ~modifier.mask })));
}

/** Every keycode whose release ends the chord. */
function chordKeycodes(binding: ShortcutBinding, grabs: X11Grab[], keymap: X11Keymap): Set<number> {
  const modifiers = binding.modifiers.flatMap((modifier) => resolveModifier(keymap, modifier)?.keycodes ?? []);
  return new Set([...modifiers, ...grabs.map((grab) => grab.keycode)]);
}

/** MIT-MAGIC-COOKIE-1 for `display` from an Xauthority file, or null. */
export function xauthCookie(file: Buffer, display: string): Buffer | null {
  let offset = 0;
  while (offset + 2 <= file.length) {
    offset += 2; // family
    const fields: Buffer[] = [];
    for (let i = 0; i < 4; i += 1) {
      const length = file.readUInt16BE(offset);
      fields.push(file.subarray(offset + 2, offset + 2 + length));
      offset += 2 + length;
    }
    const [, number, name, data] = fields;
    if (name.toString('latin1') === 'MIT-MAGIC-COOKIE-1' && (number.length === 0 || number.toString('latin1') === display)) {
      return data;
    }
  }
  return null;
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

function request(opcode: number, data: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(4);
  head[0] = opcode;
  head[1] = data;
  head.writeUInt16LE((4 + body.length) / 4, 2);
  return Buffer.concat([head, body]);
}

function grabKeyRequest(root: number, keycode: number, modifiers: number, ungrab: boolean): Buffer {
  if (ungrab) {
    const body = Buffer.alloc(8);
    body.writeUInt32LE(root, 0);
    body.writeUInt16LE(modifiers, 4);
    return request(34, keycode, body);
  }
  const body = Buffer.alloc(12);
  body.writeUInt32LE(root, 0);
  body.writeUInt16LE(modifiers, 4);
  body[6] = keycode;
  body[7] = 1; // pointer mode: async
  body[8] = 1; // keyboard mode: async
  return request(33, 0, body); // owner_events false: every key event of the grab comes to us
}

/** Bounds every request we wait on; the X server answers a local client in microseconds. */
const REPLY_TIMEOUT_MS = 2000;
/** Larger replies than this mean a desynchronised stream, not a real answer. */
const MAX_PACKET_LENGTH = 16 * 1024 * 1024;

/** Connects to the X socket and sends the setup; resolves the screen-0 root window and the keycode range. */
async function handshake(path: string, cookie: Buffer | null): Promise<{ socket: Socket; root: number; minKeycode: number; maxKeycode: number }> {
  const socket = connect(path);
  const name = Buffer.from(cookie ? 'MIT-MAGIC-COOKIE-1' : '');
  const data = cookie ?? Buffer.alloc(0);
  const head = Buffer.alloc(12);
  head[0] = 0x6c; // little-endian
  head.writeUInt16LE(11, 2);
  head.writeUInt16LE(name.length, 6);
  head.writeUInt16LE(data.length, 8);
  // Writes before 'connect' are queued.
  socket.write(Buffer.concat([head, name, Buffer.alloc(pad4(name.length)), data, Buffer.alloc(pad4(data.length))]));

  const reply = await new Promise<Buffer>((resolve, reject) => {
    let received: Buffer = Buffer.alloc(0);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', finish);
      socket.off('close', onClose);
      if (!error) return resolve(received);
      socket.destroy();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 8 && received.length >= 8 + 4 * received.readUInt16LE(6)) finish();
    };
    const onClose = () => finish(new Error('X server closed the connection during setup'));
    const timer = setTimeout(() => finish(new Error('X server did not answer the connection setup')), REPLY_TIMEOUT_MS);
    socket.on('data', onData);
    socket.once('error', finish);
    socket.once('close', onClose);
  });
  try {
    if (reply[0] !== 1) {
      const reason = reply.toString('latin1', 8, 8 + (reply[0] === 0 ? reply[1] : reply.length - 8)).replace(/\0+$/, '');
      throw new Error(`X server refused the connection: ${reason || 'no reason given'}`);
    }
    const vendorLength = reply.readUInt16LE(24);
    const screens = 40 + vendorLength + pad4(vendorLength) + 8 * reply[29];
    return { socket, root: reply.readUInt32LE(screens), minKeycode: reply[34], maxKeycode: reply[35] };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

export async function openX11Shortcuts({ onShortcut, onLost, onTriggers }: LinuxShortcutEvents): Promise<LinuxShortcutBackend> {
  const display = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(process.env.DISPLAY ?? '')?.[1];
  if (display === undefined) throw new Error(`Only local X displays are supported (DISPLAY="${process.env.DISPLAY ?? ''}").`);
  let cookie: Buffer | null = null;
  try {
    cookie = xauthCookie(readFileSync(process.env.XAUTHORITY ?? join(homedir(), '.Xauthority')), display);
  } catch {
    // No readable cookie: servers that trust the local user (xhost si:localuser) still accept us.
  }

  const { socket, root, minKeycode, maxKeycode } = await handshake(`/tmp/.X11-unix/X${display}`, cookie);

  let sequence = 0;
  let inbox: Buffer = Buffer.alloc(0);
  let closing = false;
  let closed = false;
  const replies = new Map<number, { resolve: (reply: Buffer) => void; reject: (error: Error) => void }>();
  const grabRequests = new Map<number, RecordingIntent>();
  const failedGrabs = new Set<RecordingIntent>();
  let grabs: X11Grab[] = [];
  let chords = new Map<RecordingIntent, Set<number>>();
  let active: RecordingIntent | null = null;
  let xkbEvent = -1;
  let keymap: X11Keymap = { keysyms: new Map(), modifiers: [] };
  let keymapStale = true;
  let locks = LOCK;
  /** Caps Lock and Num Lock must not disable a chord, so every grab is repeated under them. */
  const lockVariants = () => [...new Set([0, LOCK, locks & ~LOCK, locks])];
  let bindings: LinuxShortcutBindings | null = null;
  /** Binds run one at a time: grab errors are matched to their bind by sequence number. */
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task);
    queue = next.catch(() => undefined);
    return next;
  };
  /** Re-resolves the bindings against a changed keymap once no chord is held, and reports the new triggers. */
  const remap = () => {
    if (!bindings || active || closed) return;
    serially(async () => {
      if (!keymapStale || active || closed) return;
      onTriggers(await apply());
    }).catch((error) => console.error('Could not rebind X11 shortcuts after a keymap change:', error));
  };

  const send = (packet: Buffer): number => {
    sequence = (sequence + 1) & 0xffff;
    socket.write(packet);
    return sequence;
  };
  const roundtrip = (packet: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('X11 connection closed'));
    const seq = send(packet);
    const timer = setTimeout(() => {
      replies.delete(seq);
      reject(new Error('X server did not answer'));
    }, REPLY_TIMEOUT_MS);
    replies.set(seq, {
      resolve: (reply) => { clearTimeout(timer); resolve(reply); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
  /** Reports the held chord released; after an ungrab its key release never reaches us. */
  const releaseActive = () => {
    const intent = active;
    active = null;
    if (intent) onShortcut(intent, false);
  };

  const handle = (packet: Buffer) => {
    const kind = packet[0] & 0x7f;
    const seq = packet.readUInt16LE(2);
    if (kind === 0 || kind === 1) {
      const waiter = replies.get(seq);
      replies.delete(seq);
      if (kind === 1) return waiter?.resolve(packet);
      if (waiter) return waiter.reject(new Error(`X11 error ${packet[1]}`));
      const intent = grabRequests.get(seq);
      if (intent) failedGrabs.add(intent);
      else console.warn(`X11 error ${packet[1]} for request ${seq}`);
      return;
    }
    // Layout or modifier map changed (setxkbmap, xmodmap): the selected XkbNewKeyboardNotify / XkbMapNotify.
    if (kind === xkbEvent) {
      keymapStale = true;
      return remap();
    }
    if ((kind !== KEY_PRESS && kind !== KEY_RELEASE) || packet[0] & 0x80) return; // ignore synthetic events
    const keycode = packet[1];
    if (kind === KEY_PRESS) {
      if (active) return; // auto-repeat, or another key typed while the chord is held
      // Low byte only: pointer-button bits must not block a chord; lock states never do.
      const state = packet.readUInt16LE(28) & 0xff & ~locks;
      const grab = grabs.find((candidate) => candidate.keycode === keycode && candidate.modifiers === state);
      if (!grab) return;
      active = grab.intent;
      onShortcut(grab.intent, true);
    } else if (active && chords.get(active)?.has(keycode)) {
      const intent = active;
      active = null;
      onShortcut(intent, false);
      if (keymapStale) remap();
    }
  };

  socket.on('data', (chunk: Buffer) => {
    inbox = inbox.length ? Buffer.concat([inbox, chunk]) : chunk;
    while (inbox.length >= 32) {
      const kind = inbox[0] & 0x7f;
      // Replies and GenericEvents carry extra 4-byte units; everything else is 32 bytes.
      const length = kind === 1 || kind === 35 ? 32 + 4 * inbox.readUInt32LE(4) : 32;
      if (length > MAX_PACKET_LENGTH) {
        console.error('Dropping X11 connection after an oversized packet');
        socket.destroy();
        return;
      }
      if (inbox.length < length) break;
      const packet = inbox.subarray(0, length);
      inbox = inbox.subarray(length);
      handle(packet);
    }
  });
  socket.on('error', (error) => console.error('X11 connection error:', error));
  socket.on('close', () => {
    closed = true;
    for (const { reject } of replies.values()) reject(new Error('X11 connection closed'));
    replies.clear();
    if (!closing) onLost();
  });

  try {
    // Without detectable auto-repeat a held key reports release/press pairs,
    // which would end push-to-talk on the first repeat.
    const nameBytes = Buffer.from('XKEYBOARD');
    const queryBody = Buffer.alloc(4 + nameBytes.length + pad4(nameBytes.length));
    queryBody.writeUInt16LE(nameBytes.length, 0);
    nameBytes.copy(queryBody, 4);
    const extension = await roundtrip(request(98, 0, queryBody));
    if (!extension[8]) throw new Error('the X server lacks the XKEYBOARD extension');
    const xkb = extension[9];
    const useBody = Buffer.alloc(4);
    useBody.writeUInt16LE(1, 0);
    if (!(await roundtrip(request(xkb, 0, useBody)))[1]) throw new Error('the X server rejected XKB 1.0');
    const flagsBody = Buffer.alloc(24);
    flagsBody.writeUInt16LE(0x100, 0); // core keyboard
    flagsBody.writeUInt32LE(1, 4); // change: DetectableAutoRepeat
    flagsBody.writeUInt32LE(1, 8); // value
    const flags = await roundtrip(request(xkb, 21, flagsBody));
    if (!(flags.readUInt32LE(12) & 1)) throw new Error('the X server cannot report held keys without auto-repeat releases');
    // An XKB client gets no core MappingNotify for layout switches or modifier
    // map edits, so select the XKB events instead: NewKeyboardNotify, and MapNotify for keysyms + modmap.
    const selectBody = Buffer.alloc(12);
    selectBody.writeUInt16LE(0x100, 0); // core keyboard
    selectBody.writeUInt16LE(3, 2); // affect: NewKeyboardNotify | MapNotify
    selectBody.writeUInt16LE(1, 6); // select all NewKeyboardNotify details
    selectBody.writeUInt16LE(6, 8); // affect map: KeySyms | ModifierMap
    selectBody.writeUInt16LE(6, 10); // map
    send(request(xkb, 1, selectBody));
    xkbEvent = extension[10];
  } catch (error) {
    closing = true;
    socket.destroy();
    // oxlint-disable-next-line preserve-caught-error -- the message carries the cause; the ES2020 lib has no Error cause option.
    throw new Error(`X11 shortcuts are unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const loadKeymap = async (): Promise<X11Keymap> => {
    const count = maxKeycode - minKeycode + 1;
    const mappingBody = Buffer.alloc(4);
    mappingBody[0] = minKeycode;
    mappingBody[1] = count;
    const [keyboard, modifierMap] = await Promise.all([roundtrip(request(101, 0, mappingBody)), roundtrip(request(119, 0))]);
    const perKey = keyboard[1];
    if (keyboard.readUInt32LE(4) !== count * perKey) throw new Error('X server sent a malformed keyboard mapping');
    const keysyms = new Map<number, number>();
    for (let i = 0; perKey > 0 && i < count; i += 1) keysyms.set(minKeycode + i, keyboard.readUInt32LE(32 + i * perKey * 4));
    const perModifier = modifierMap[1];
    const modifiers = Array.from({ length: 8 }, (_, row) =>
      [...modifierMap.subarray(32 + row * perModifier, 32 + (row + 1) * perModifier)].filter((keycode) => keycode !== 0));
    return { keysyms, modifiers };
  };

  const ungrab = (grab: X11Grab) => {
    for (const lock of lockVariants()) send(grabKeyRequest(root, grab.keycode, grab.modifiers | lock, true));
  };

  /** Replaces every grab with `bindings` resolved against the current keymap. */
  const apply = async (): Promise<LinuxShortcutTriggers> => {
    releaseActive();
    if (keymapStale) {
      keymapStale = false;
      try {
        keymap = await loadKeymap();
      } catch (error) {
        keymapStale = true;
        throw error;
      }
    }
    locks = ignoredLocks(keymap);
    send(grabKeyRequest(root, ANY_KEY, ANY_MODIFIER, true));
    grabRequests.clear();
    failedGrabs.clear();
    const entries = Object.entries(bindings ?? {}) as Array<[RecordingIntent, ShortcutBinding]>;
    const next: X11Grab[] = [];
    const nextChords = new Map<RecordingIntent, Set<number>>();
    for (const [intent, binding] of entries) {
      const intentGrabs = x11Grabs(intent, binding, keymap);
      if (intentGrabs.length === 0) failedGrabs.add(intent);
      for (const grab of intentGrabs) {
        for (const lock of lockVariants()) {
          grabRequests.set(send(grabKeyRequest(root, grab.keycode, grab.modifiers | lock, false)), intent);
        }
      }
      next.push(...intentGrabs);
      nextChords.set(intent, chordKeycodes(binding, intentGrabs, keymap));
    }
    // Errors arrive in request order, so every grab's BadAccess precedes this reply.
    await roundtrip(request(43, 0));
    grabRequests.clear();
    // A partly grabbed chord would work only under some lock states; drop it whole.
    for (const grab of next) if (failedGrabs.has(grab.intent)) ungrab(grab);
    grabs = next.filter((grab) => !failedGrabs.has(grab.intent));
    chords = nextChords;
    return Object.fromEntries(entries.map(([intent, binding]) => [
      intent,
      failedGrabs.has(intent) ? null : formatBinding(binding),
    ]));
  };

  return {
    kind: 'x11',
    bind(next: LinuxShortcutBindings) {
      releaseActive();
      return serially(() => {
        bindings = next;
        return apply();
      });
    },
    async keysHeld() {
      const keymap = await roundtrip(request(44, 0));
      return keymap.subarray(8, 40).some((byte) => byte !== 0);
    },
    close() {
      closing = true;
      active = null;
      socket.destroy();
    },
  };
}
