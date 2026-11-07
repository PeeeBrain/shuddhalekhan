import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import koffi from 'koffi';
import { captureX11Target } from '../x11-target';
import { openX11ClipboardMonitor } from '../x11-clipboard';
import { simulateX11Paste } from '../x11-paste';
import { openX11Shortcuts } from '../../desktop/x11-shortcuts';

// Native server/process checks are opt-in; ordinary unit tests never spawn a display.
describe.skipIf(process.env.SHUDDHALEKHAN_X11_INTEGRATION !== '1')('X11 target identity', () => {
  let server: ChildProcess;
  const previousDisplay = process.env.DISPLAY;
  let close: (() => void) | undefined;
  let focus: (window: number) => void;
  let first: number;
  let second: number;
  let ownClipboard: (window: number) => void;
  let remap: (code: number, lower: number, upper: number) => void;
  let readKeys: () => Array<{ type: number; key: number }>;
  let sendKey: (key: number, down: boolean) => void;

  beforeAll(async () => {
    server = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '800x600x24', '-nolisten', 'tcp'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const display = await new Promise<string>((resolve, reject) => {
      let output = '';
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`Xvfb exited before readiness (${code})`)));
      server.stdout?.on('data', chunk => {
        output += String(chunk);
        const number = /^(\d+)\n/.exec(output)?.[1];
        if (number) resolve(`:${number}`);
      });
    });
    process.env.DISPLAY = display;
    const xcb = koffi.load('libxcb.so.1');
    const cookie = koffi.struct({ sequence: 'uint32_t' });
    const iterator = koffi.struct({ data: 'void *', rem: 'int', index: 'int' });
    const connection = xcb.func('void *xcb_connect(const char *, void *)')(display, null);
    const disconnect = xcb.func('void xcb_disconnect(void *)');
    close = () => disconnect(connection);
    const setup = xcb.func('void *xcb_get_setup(void *)')(connection);
    const screen = xcb.func('xcb_setup_roots_iterator', iterator, ['void *'])(setup);
    const root = Buffer.from(koffi.decode(screen.data, 'uint8_t', 4)).readUInt32LE();
    const generateId = xcb.func('uint32_t xcb_generate_id(void *)');
    const create = xcb.func('xcb_create_window', cookie,
      ['void *', 'uint8_t', 'uint32_t', 'uint32_t', 'int16_t', 'int16_t', 'uint16_t', 'uint16_t', 'uint16_t', 'uint16_t', 'uint32_t', 'uint32_t', 'void *']);
    const map = xcb.func('xcb_map_window', cookie, ['void *', 'uint32_t']);
    const setFocus = xcb.func('xcb_set_input_focus', cookie, ['void *', 'uint8_t', 'uint32_t', 'uint32_t']);
    const flush = xcb.func('int xcb_flush(void *)');
    const atom = xcb.func('xcb_intern_atom', cookie, ['void *', 'uint8_t', 'uint16_t', 'str']);
    const atomReply = xcb.func('xcb_intern_atom_reply', 'void *', ['void *', cookie, 'void *']);
    const free = koffi.load('libc.so.6').func('void free(void *)');
    const atomCookie = atom(connection, 0, 11, '_NET_WM_PID');
    const pointer = atomReply(connection, atomCookie, null);
    if (!pointer) throw new Error(`X11 InternAtom failed: ${JSON.stringify(atomCookie)}, connection error ${xcb.func('int xcb_connection_has_error(void *)')(connection)}`);
    const pidAtom = Buffer.from(koffi.decode(pointer, 'uint8_t', 12)).readUInt32LE(8);
    free(pointer);
    const change = xcb.func('xcb_change_property', cookie,
      ['void *', 'uint8_t', 'uint32_t', 'uint32_t', 'uint32_t', 'uint8_t', 'uint32_t', 'void *']);
    const clipboardPointer = atomReply(connection, atom(connection, 0, 9, 'CLIPBOARD'), null);
    const clipboard = Buffer.from(koffi.decode(clipboardPointer, 'uint8_t', 12)).readUInt32LE(8);
    free(clipboardPointer);
    const setOwner = xcb.func('xcb_set_selection_owner', cookie, ['void *', 'uint32_t', 'uint32_t', 'uint32_t']);
    const pid = Buffer.alloc(4);
    pid.writeUInt32LE(process.pid);
    const eventMask = Buffer.alloc(4);
    eventMask.writeUInt32LE(3);
    const makeWindow = (parent: number) => {
      const window: number = generateId(connection);
      create(connection, 0, window, parent, 0, 0, 100, 100, 0, 1, 0, 2048, eventMask);
      map(connection, window);
      return window;
    };
    const parent = makeWindow(root);
    change(connection, 0, parent, pidAtom, 6, 32, 1, pid);
    first = makeWindow(parent);
    second = makeWindow(parent);
    const sync = xcb.func('xcb_get_input_focus', cookie, ['void *']);
    const syncReply = xcb.func('xcb_get_input_focus_reply', 'void *', ['void *', cookie, 'void *']);
    focus = window => {
      setFocus(connection, 0, window, 0);
      flush(connection);
      const done = syncReply(connection, sync(connection), null);
      if (!done) throw new Error('X11 fixture could not synchronize');
      free(done);
    };
    ownClipboard = window => {
      setOwner(connection, window, clipboard, 0);
      const done = syncReply(connection, sync(connection), null);
      if (!done) throw new Error('X11 fixture could not set the selection owner');
      free(done);
    };
    const mapping = xcb.func('xcb_change_keyboard_mapping_checked', cookie,
      ['void *', 'uint8_t', 'uint8_t', 'uint8_t', 'void *']);
    const check = xcb.func('xcb_request_check', 'void *', ['void *', cookie]);
    const fake = koffi.load('libxcb-xtest.so.0').func('xcb_test_fake_input_checked', cookie,
      ['void *', 'uint8_t', 'uint8_t', 'uint32_t', 'uint32_t', 'int16_t', 'int16_t', 'uint8_t']);
    sendKey = (key, down) => {
      const error = check(connection, fake(connection, down ? 2 : 3, key, 0, 0, 0, 0, 0));
      if (error) { free(error); throw new Error('Could not send fixture key'); }
    };
    remap = (code, lower, upper) => {
      const symbols = Buffer.alloc(8);
      symbols.writeUInt32LE(lower);
      symbols.writeUInt32LE(upper, 4);
      const error = check(connection, mapping(connection, 1, code, 2, symbols));
      if (error) { free(error); throw new Error('Could not change the fixture keymap'); }
    };
    const poll = xcb.func('void *xcb_poll_for_event(void *)');
    readKeys = () => {
      const done = syncReply(connection, sync(connection), null);
      if (!done) throw new Error('Could not synchronize input events');
      free(done);
      const keys: Array<{ type: number; key: number }> = [];
      for (let event = poll(connection); event; event = poll(connection)) {
        const bytes = Buffer.from(koffi.decode(event, 'uint8_t', 32));
        free(event);
        if (bytes[0] === 2 || bytes[0] === 3) keys.push({ type: bytes[0], key: bytes[1] });
      }
      return keys;
    };
    focus(first);
  });

  afterAll(async () => {
    close?.();
    if (previousDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = previousDisplay;
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>(resolve => server.once('exit', () => resolve()));
      server.kill('SIGTERM');
      await exited;
    }
  });

  it('resolves child focus through its parent and distinguishes windows in the same process', () => {
    const original = captureX11Target();
    expect(original).toMatchObject({ kind: 'x11', windowId: first, processId: process.pid });
    focus(second);
    expect(captureX11Target()).toMatchObject({ kind: 'x11', windowId: second, processId: process.pid });
    expect(captureX11Target()).toMatchObject({ processStartTime: original?.kind === 'x11' ? original.processStartTime : '' });
  });

  it('rejects an absent input focus rather than inventing a target', () => {
    focus(0);
    expect(captureX11Target()).toBeNull();
  });

  it('counts a new copy from the same owner without comparing clipboard text', () => {
    const monitor = openX11ClipboardMonitor();
    try {
      const before = monitor.sequence();
      ownClipboard(first);
      const firstCopy = monitor.sequence();
      expect(firstCopy).toBeGreaterThan(before);
      ownClipboard(first);
      expect(monitor.sequence()).toBeGreaterThan(firstCopy);
    } finally { monitor.close(); }
  });

  it('dispatches the paste chord using a remapped V key and releases both keys', () => {
    focus(first);
    remap(55, 0, 0);
    remap(251, 0x76, 0x56);
    readKeys();
    expect(simulateX11Paste('ctrl-v')).toEqual({ acceptedEvents: 4 });
    const keys = readKeys();
    expect(keys).toHaveLength(4);
    expect(keys[1]).toEqual({ type: 2, key: 251 });
    expect(keys[2]).toEqual({ type: 3, key: 251 });
    expect(keys[3]).toEqual({ type: 3, key: keys[0]?.key ?? -1 });
  });

  it('delivers a remapped shortcut press and its real release while tracking held keys', async () => {
    let reportPress = () => {};
    let reportRelease = () => {};
    const pressed = new Promise<void>(resolve => { reportPress = resolve; });
    const released = new Promise<void>(resolve => { reportRelease = resolve; });
    const events: boolean[] = [];
    const backend = await openX11Shortcuts({
      onShortcut: (_intent, down) => { events.push(down); if (down) reportPress(); else reportRelease(); },
      onLost: () => {}, onTriggers: () => {},
    });
    try {
      expect((await backend.bind({ dictation: { keyCode: 0x56, modifiers: ['ctrl'] } })).dictation).toBeTruthy();
      focus(first);
      sendKey(37, true);
      sendKey(251, true);
      await pressed;
      expect(await backend.keysHeld()).toBe(true);
      sendKey(251, false);
      sendKey(37, false);
      await released;
      expect(await backend.keysHeld()).toBe(false);
      expect(events).toEqual([true, false]);
    } finally {
      sendKey(251, false);
      sendKey(37, false);
      backend.close();
    }
  });
});
