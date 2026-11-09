import koffi from 'koffi';
import { buildPasteStrategyEvents, PASTE_KEYSYMS } from '../paste-strategy';
import type { PasteStrategy } from '../../types/ipc';

/** XTEST dispatch uses the server's current keymap, with no uinput device or input-group access. */
export function simulateX11Paste(strategy: PasteStrategy): { acceptedEvents: number } {
  const xcb = koffi.load('libxcb.so.1');
  const test = koffi.load('libxcb-xtest.so.0');
  const free = koffi.load('libc.so.6').func('void free(void *)');
  const cookie = koffi.struct({ sequence: 'uint32_t' });
  const connection = xcb.func('void *xcb_connect(const char *, void *)')(process.env.DISPLAY ?? null, null);
  const disconnect = xcb.func('void xcb_disconnect(void *)');
  const hasError = xcb.func('int xcb_connection_has_error(void *)');
  let acceptedEvents = 0;
  try {
    if (!connection || hasError(connection)) return { acceptedEvents };
    const setupPointer = xcb.func('void *xcb_get_setup(void *)')(connection);
    const setup = Buffer.from(koffi.decode(setupPointer, 'uint8_t', 40));
    const first = setup[34];
    const count = setup[35] - first + 1;
    const mapping = xcb.func('xcb_get_keyboard_mapping', cookie, ['void *', 'uint8_t', 'uint8_t']);
    const mappingReply = xcb.func('xcb_get_keyboard_mapping_reply', 'void *', ['void *', cookie, 'void *']);
    const pointer = mappingReply(connection, mapping(connection, first, count), null);
    if (!pointer) return { acceptedEvents };
    const keycodes = new Map<number, number>();
    try {
      const header = Buffer.from(koffi.decode(pointer, 'uint8_t', 32));
      const perKey = header[1];
      if (perKey === 0 || header.readUInt32LE(4) !== count * perKey) return { acceptedEvents };
      const bytes = Buffer.from(koffi.decode(pointer, 'uint8_t', 32 + count * perKey * 4));
      for (const [vk, keysym] of PASTE_KEYSYMS) {
        for (let key = 0; key < count; key += 1) {
          if (bytes.readUInt32LE(32 + key * perKey * 4) === keysym) {
            keycodes.set(vk, first + key);
            break;
          }
        }
      }
    } finally { free(pointer); }
    const events = buildPasteStrategyEvents(strategy);
    if (events.some(event => !keycodes.has(event.vk))) return { acceptedEvents };
    const input = test.func('xcb_test_fake_input_checked', cookie,
      ['void *', 'uint8_t', 'uint8_t', 'uint32_t', 'uint32_t', 'int16_t', 'int16_t', 'uint8_t']);
    const check = xcb.func('xcb_request_check', 'void *', ['void *', cookie]);
    const down = new Set<number>();
    const send = (key: number, up: boolean): boolean => {
      const error = check(connection, input(connection, up ? 3 : 2, key, 0, 0, 0, 0, 0));
      if (error) { free(error); return false; }
      return !hasError(connection);
    };
    try {
      for (const event of events) {
        const key = keycodes.get(event.vk);
        if (key === undefined) break;
        const up = event.up;
        if (!send(key, up)) break;
        if (up) down.delete(key);
        else down.add(key);
        acceptedEvents += 1;
      }
    } finally {
      for (const key of down) send(key, true);
    }
    return { acceptedEvents };
  } finally { if (connection) disconnect(connection); }
}
