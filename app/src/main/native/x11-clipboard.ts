import koffi from 'koffi';

/** Counts real CLIPBOARD ownership events, including reacquisition by the same window. */
export function openX11ClipboardMonitor(): { sequence(): number; close(): void } {
  const xcb = koffi.load('libxcb.so.1');
  const fixes = koffi.load('libxcb-xfixes.so.0');
  const free = koffi.load('libc.so.6').func('void free(void *)');
  const cookie = koffi.struct({ sequence: 'uint32_t' });
  const iterator = koffi.struct({ data: 'void *', rem: 'int', index: 'int' });
  const connection = xcb.func('void *xcb_connect(const char *, void *)')(process.env.DISPLAY ?? null, null);
  const disconnect = xcb.func('void xcb_disconnect(void *)');
  const hasError = xcb.func('int xcb_connection_has_error(void *)');
  let closed = false;
  const close = () => {
    if (!closed && connection) disconnect(connection);
    closed = true;
  };
  if (!connection || hasError(connection)) {
    close();
    throw new Error('The X11 clipboard connection is unavailable.');
  }
  const checked = xcb.func('xcb_request_check', 'void *', ['void *', cookie]);
  const check = (request: unknown) => {
    const error = checked(connection, request);
    if (error) {
      free(error);
      throw new Error('The X11 clipboard monitor request failed.');
    }
  };
  try {
    const query = fixes.func('xcb_xfixes_query_version', cookie, ['void *', 'uint32_t', 'uint32_t']);
    const queryReply = fixes.func('xcb_xfixes_query_version_reply', 'void *', ['void *', cookie, 'void *']);
    const version = queryReply(connection, query(connection, 5, 0), null);
    if (!version) throw new Error('XFixes clipboard ownership tracking is unavailable.');
    free(version);
    const setup = xcb.func('void *xcb_get_setup(void *)')(connection);
    const screen = xcb.func('xcb_setup_roots_iterator', iterator, ['void *'])(setup);
    const root = Buffer.from(koffi.decode(screen.data, 'uint8_t', 4)).readUInt32LE();
    const window: number = xcb.func('uint32_t xcb_generate_id(void *)')(connection);
    const create = xcb.func('xcb_create_window_checked', cookie,
      ['void *', 'uint8_t', 'uint32_t', 'uint32_t', 'int16_t', 'int16_t', 'uint16_t', 'uint16_t', 'uint16_t', 'uint16_t', 'uint32_t', 'uint32_t', 'void *']);
    check(create(connection, 0, window, root, 0, 0, 1, 1, 0, 2, 0, 0, null));
    const atom = xcb.func('xcb_intern_atom', cookie, ['void *', 'uint8_t', 'uint16_t', 'str']);
    const atomReply = xcb.func('xcb_intern_atom_reply', 'void *', ['void *', cookie, 'void *']);
    const atomPointer = atomReply(connection, atom(connection, 0, 9, 'CLIPBOARD'), null);
    if (!atomPointer) throw new Error('The X11 clipboard atom is unavailable.');
    let selection: number;
    try { selection = Buffer.from(koffi.decode(atomPointer, 'uint8_t', 12)).readUInt32LE(8); }
    finally { free(atomPointer); }
    const select = fixes.func('xcb_xfixes_select_selection_input_checked', cookie, ['void *', 'uint32_t', 'uint32_t', 'uint32_t']);
    check(select(connection, window, selection, 7));
    const sync = xcb.func('xcb_get_input_focus', cookie, ['void *']);
    const syncReply = xcb.func('xcb_get_input_focus_reply', 'void *', ['void *', cookie, 'void *']);
    const poll = xcb.func('void *xcb_poll_for_event(void *)');
    let sequence = 0;
    return {
      close,
      sequence() {
        if (closed || hasError(connection)) throw new Error('The X11 clipboard monitor disconnected.');
        // A round trip puts prior ownership changes into this connection's queue.
        const done = syncReply(connection, sync(connection), null);
        if (!done) throw new Error('The X11 clipboard monitor could not synchronize.');
        free(done);
        for (let event = poll(connection); event; event = poll(connection)) {
          try {
            const bytes = Buffer.from(koffi.decode(event, 'uint8_t', 32));
            if (bytes[0] === 0) throw new Error('The X11 clipboard monitor received a protocol error.');
            if (bytes.readUInt32LE(12) === selection) sequence += 1;
          } finally { free(event); }
        }
        return sequence;
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
