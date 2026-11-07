import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import koffi from 'koffi';
import type { LinuxShortcutBackend } from '../linux-shortcuts';
import { openX11Shortcuts } from '../x11-shortcuts';

// Opt-in: spawns a private X server (Xvfb by default; `SHUDDHALEKHAN_X11_SERVER="Xwayland -rootless"`
// works inside a Wayland session). Every grab stays on that server.
describe.skipIf(process.env.SHUDDHALEKHAN_X11_INTEGRATION !== '1')('X11 shortcut grabs on a live server', () => {
  const CONTROL = 4;
  const LOCK = 2;
  const MOD2 = 16;
  const MOD3 = 32;
  const QWERTY_V = 55;
  const QWERTY_PERIOD = 60;
  const SPARE = 251;
  const NUM_LOCK = 77;
  let server: ChildProcess;
  const previous = { display: process.env.DISPLAY, xauthority: process.env.XAUTHORITY };
  let disconnect: (() => void) | undefined;
  let remap: (keycode: number, lower: number, upper: number) => void;
  let moveModifier: (keycode: number, row: number) => void;
  /** True when the backend holds this exact grab: our competing GrabKey then fails with BadAccess. */
  let grabbed: (keycode: number, modifiers: number) => boolean;
  let backend: LinuxShortcutBackend;
  const events = { onShortcut: mock(), onLost: mock(), onTriggers: mock() };
  /** Resolves once the backend reports `expected`; one change may be reported more than once. */
  const triggersBecome = (expected: unknown) => new Promise<void>((resolve) => {
    events.onTriggers.mockImplementation((triggers: unknown) => { if (isDeepStrictEqual(triggers, expected)) resolve(); });
  });

  beforeAll(async () => {
    const [command, ...args] = (process.env.SHUDDHALEKHAN_X11_SERVER ?? 'Xvfb -screen 0 800x600x24').split(' ');
    server = spawn(command, [...args, '-displayfd', '1', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const display = await new Promise<string>((resolve, reject) => {
      let output = '';
      server.once('error', reject);
      server.once('exit', (code) => reject(new Error(`${command} exited before readiness (${code})`)));
      server.stdout?.on('data', (chunk) => {
        output += String(chunk);
        const number = /^(\d+)\n/.exec(output)?.[1];
        if (number) resolve(`:${number}`);
      });
    });
    process.env.DISPLAY = display;
    process.env.XAUTHORITY = '/dev/null'; // the private server trusts local clients

    const xcb = koffi.load('libxcb.so.1');
    const free = koffi.load('libc.so.6').func('void free(void *)');
    const cookie = koffi.struct({ sequence: 'uint32_t' });
    const iterator = koffi.struct({ data: 'void *', rem: 'int', index: 'int' });
    const connection = xcb.func('void *xcb_connect(const char *, void *)')(display, null);
    disconnect = () => xcb.func('void xcb_disconnect(void *)')(connection);
    const screen = xcb.func('xcb_setup_roots_iterator', iterator, ['void *'])(xcb.func('void *xcb_get_setup(void *)')(connection));
    const root = Buffer.from(koffi.decode(screen.data, 'uint8_t', 4)).readUInt32LE();
    const check = xcb.func('xcb_request_check', 'void *', ['void *', cookie]);
    /** X error code of a checked request, or 0. */
    const errorOf = (result: unknown): number => {
      const error = check(connection, result);
      if (!error) return 0;
      const code = Buffer.from(koffi.decode(error, 'uint8_t', 2))[1];
      free(error);
      return code;
    };
    const changeMapping = xcb.func('xcb_change_keyboard_mapping_checked', cookie, ['void *', 'uint8_t', 'uint8_t', 'uint8_t', 'void *']);
    remap = (keycode, lower, upper) => {
      const symbols = Buffer.alloc(8);
      symbols.writeUInt32LE(lower);
      symbols.writeUInt32LE(upper, 4);
      if (errorOf(changeMapping(connection, 1, keycode, 2, symbols))) throw new Error('X11 fixture could not change the keymap');
    };
    const grabKey = xcb.func('xcb_grab_key_checked', cookie, ['void *', 'uint8_t', 'uint32_t', 'uint16_t', 'uint8_t', 'uint8_t', 'uint8_t']);
    const ungrabKey = xcb.func('xcb_ungrab_key_checked', cookie, ['void *', 'uint8_t', 'uint32_t', 'uint16_t']);
    grabbed = (keycode, modifiers) => {
      const error = errorOf(grabKey(connection, 0, root, modifiers, keycode, 1, 1));
      if (error === 0) errorOf(ungrabKey(connection, keycode, root, modifiers));
      else if (error !== 10) throw new Error(`X11 fixture GrabKey failed with error ${error}`);
      return error === 10; // BadAccess
    };
    const getModifiers = xcb.func('xcb_get_modifier_mapping', cookie, ['void *']);
    const getModifiersReply = xcb.func('xcb_get_modifier_mapping_reply', 'void *', ['void *', cookie, 'void *']);
    const setModifiers = xcb.func('xcb_set_modifier_mapping', cookie, ['void *', 'uint8_t', 'void *']);
    const setModifiersReply = xcb.func('xcb_set_modifier_mapping_reply', 'void *', ['void *', cookie, 'void *']);
    moveModifier = (keycode, row) => {
      const reply = getModifiersReply(connection, getModifiers(connection), null);
      if (!reply) throw new Error('X11 fixture could not read the modifier map');
      const perModifier = Buffer.from(koffi.decode(reply, 'uint8_t', 2))[1];
      const map = Buffer.from(koffi.decode(reply, 'uint8_t', 32 + 8 * perModifier)).subarray(32);
      free(reply);
      const rows = Array.from({ length: 8 }, (_, i) =>
        [...map.subarray(i * perModifier, (i + 1) * perModifier)].filter((code) => code !== keycode && code !== 0));
      rows[row].push(keycode);
      const width = Math.max(...rows.map((codes) => codes.length));
      const next = Buffer.alloc(8 * width);
      rows.forEach((codes, i) => next.set(codes, i * width));
      const result = setModifiersReply(connection, setModifiers(connection, width, next), null);
      if (!result) throw new Error('X11 fixture could not set the modifier map');
      const status = Buffer.from(koffi.decode(result, 'uint8_t', 2))[1];
      free(result);
      if (status !== 0) throw new Error(`X11 fixture could not set the modifier map (status ${status})`);
    };

    // Dvorak's V: the QWERTY V position types k, and v sits on the QWERTY '.' key.
    remap(QWERTY_V, 0x6b, 0x4b);
    remap(QWERTY_PERIOD, 0x76, 0x56);
    backend = await openX11Shortcuts(events);
    expect(await backend.bind({ dictation: { keyCode: 0x56, modifiers: ['ctrl'] } })).toEqual({ dictation: 'Ctrl + V' });
  });

  afterAll(async () => {
    backend?.close();
    disconnect?.();
    for (const [name, value] of [['DISPLAY', previous.display], ['XAUTHORITY', previous.xauthority]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
      server.kill('SIGTERM');
      await exited;
    }
  });

  it('grabs the key the layout types V with, not the QWERTY V position', () => {
    expect(grabbed(QWERTY_PERIOD, CONTROL)).toBe(true);
    expect(grabbed(QWERTY_PERIOD, CONTROL | LOCK | MOD2)).toBe(true);
    expect(grabbed(QWERTY_V, CONTROL)).toBe(false);
  });

  it('follows a keymap change while bound and reports the reassigned trigger', async () => {
    let triggers = triggersBecome({ dictation: null });
    remap(QWERTY_PERIOD, 0x2e, 0x3e);
    await triggers;
    expect(grabbed(QWERTY_PERIOD, CONTROL)).toBe(false);
    triggers = triggersBecome({ dictation: 'Ctrl + V' });
    remap(SPARE, 0x76, 0x56);
    await triggers;
    expect(grabbed(SPARE, CONTROL)).toBe(true);
  });

  it('repeats grabs under Num Lock on whichever modifier row the server puts it', async () => {
    const triggers = triggersBecome({ dictation: 'Ctrl + V' });
    moveModifier(NUM_LOCK, 5); // Mod3 instead of the usual Mod2
    await triggers;
    expect(grabbed(SPARE, CONTROL | MOD3)).toBe(true);
    expect(grabbed(SPARE, CONTROL | LOCK | MOD3)).toBe(true);
    expect(grabbed(SPARE, CONTROL | MOD2)).toBe(false);
  });

  it('reports the chord unassigned once no key types V', async () => {
    const triggers = triggersBecome({ dictation: null });
    remap(SPARE, 0, 0);
    await triggers;
    expect(grabbed(SPARE, CONTROL)).toBe(false);
    expect(events.onShortcut).not.toHaveBeenCalled();
    expect(events.onLost).not.toHaveBeenCalled();
  });
});
