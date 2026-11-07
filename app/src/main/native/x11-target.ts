import koffi from 'koffi';
import { readFileSync, readlinkSync } from 'node:fs';
import type { DictationTargetSnapshot } from '../../shared/dictation-target';

function loadXcb() {
  const lib = koffi.load('libxcb.so.1');
  const libc = koffi.load('libc.so.6');
  const cookie = koffi.struct({ sequence: 'uint32_t' });
  return {
    connect: lib.func('void *xcb_connect(const char *, void *)'),
    disconnect: lib.func('void xcb_disconnect(void *)'),
    error: lib.func('int xcb_connection_has_error(void *)'),
    focus: lib.func('xcb_get_input_focus', cookie, ['void *']),
    focusReply: lib.func('xcb_get_input_focus_reply', 'void *', ['void *', cookie, 'void *']),
    atom: lib.func('xcb_intern_atom', cookie, ['void *', 'uint8_t', 'uint16_t', 'str']),
    atomReply: lib.func('xcb_intern_atom_reply', 'void *', ['void *', cookie, 'void *']),
    property: lib.func('xcb_get_property', cookie, ['void *', 'uint8_t', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t']),
    propertyReply: lib.func('xcb_get_property_reply', 'void *', ['void *', cookie, 'void *']),
    tree: lib.func('xcb_query_tree', cookie, ['void *', 'uint32_t']),
    treeReply: lib.func('xcb_query_tree_reply', 'void *', ['void *', cookie, 'void *']),
    free: libc.func('void free(void *)'),
  };
}

let api: ReturnType<typeof loadXcb> | undefined;

/** X11 window identity only; same-window widget/caret changes are not observable here. */
export function captureX11Target(): DictationTargetSnapshot | null {
  try { api ??= loadXcb(); } catch { return null; }
  const xcb = api;
  const connection = xcb.connect(process.env.DISPLAY ?? null, null);
  if (!connection) return null;
  const reply = (pointer: unknown): Buffer | null => {
    if (!pointer) return null;
    try { return Buffer.from(koffi.decode(pointer, 'uint8_t', 32)); }
    finally { xcb.free(pointer); }
  };
  try {
    if (xcb.error(connection)) return null;
    const focused = () => reply(xcb.focusReply(connection, xcb.focus(connection), null))?.readUInt32LE(8) ?? 0;
    const windowId = focused();
    if (windowId <= 1) return null;
    const name = '_NET_WM_PID';
    const atom = reply(xcb.atomReply(connection, xcb.atom(connection, 1, name.length, name), null))?.readUInt32LE(8) ?? 0;
    if (!atom) return null;
    let window = windowId;
    let processId = 0;
    // Toolkits may focus a child while publishing their PID on the top-level window.
    for (let depth = 0; window > 1 && depth < 64; depth += 1) {
      const pointer = xcb.propertyReply(connection, xcb.property(connection, 0, window, atom, 6, 0, 1), null);
      if (pointer) {
        try {
          const header = Buffer.from(koffi.decode(pointer, 'uint8_t', 32));
          if (header[1] === 32 && header.readUInt32LE(16) === 1) {
            processId = Buffer.from(koffi.decode(pointer, 'uint8_t', 36)).readUInt32LE(32);
          }
        } finally { xcb.free(pointer); }
      }
      if (processId) break;
      const tree = reply(xcb.treeReply(connection, xcb.tree(connection, window), null));
      const parent = tree?.readUInt32LE(12) ?? 0;
      if (!parent || parent === window) return null;
      window = parent;
    }
    if (!processId) return null;
    const stat = readFileSync(`/proc/${processId}/stat`, 'utf8');
    const startTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    if (!startTicks || !/^\d+$/.test(startTicks)) return null;
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    let executablePath: string | null = null;
    try { executablePath = readlinkSync(`/proc/${processId}/exe`); } catch { /* Process visibility may be restricted. */ }
    if (focused() !== windowId) return null;
    return { kind: 'x11', windowId, processId, processStartTime: `${bootId}:${startTicks}`,
      executablePath, capturedAt: new Date().toISOString() };
  } catch {
    return null;
  } finally { xcb.disconnect(connection); }
}
