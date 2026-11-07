import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { createServer, type Server, type Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { decodeMessage, encodeMessage, METHOD_CALL, SIGNAL, type DBusMessage, type OutgoingMessage } from '../dbus';
import { openGlobalShortcutsPortal, preferredTrigger } from '../global-shortcuts-portal';
import { x11Grabs, xauthCookie, type X11Keymap } from '../x11-shortcuts';

const METHOD_RETURN = 2;
const PORTAL_OWNER = ':1.2';
const SESSION = '/org/freedesktop/portal/desktop/session/1_7/s';

/**
 * A session bus with a GlobalShortcuts portal behind it, on a private socket.
 * BindShortcuts answers only when `answerBinds` is set, like a pending user dialog.
 */
async function fakePortalBus() {
  const path = join(mkdtempSync(join(tmpdir(), 'fake-bus-')), 'bus');
  const calls: DBusMessage[] = [];
  const waiters: Array<{ member: string; times: number; resolve: () => void }> = [];
  const count = (member: string) => calls.filter((call) => call.member === member).length;
  let client: Socket | undefined;
  let serial = 100;
  const bus = {
    answerBinds: true,
    send: (message: Omit<OutgoingMessage, 'serial'>) => client?.write(encodeMessage({ serial: ++serial, ...message })),
    signal: (sender: string, path: string, iface: string, member: string, signature: string, body: unknown[]) =>
      bus.send({ type: SIGNAL, sender, path, interface: iface, member, signature, body }),
    /** Resolves once the client has called `member` `times` times. */
    called: (member: string, times = 1) => new Promise<void>((resolve) => {
      if (count(member) >= times) resolve();
      else waiters.push({ member, times, resolve });
    }),
    server: undefined as Server | undefined,
  };
  const respond = (call: DBusMessage, results: Record<string, unknown>) => {
    const options = call.body[call.body.length - 1] as { handle_token: string };
    const request = `/org/freedesktop/portal/desktop/request/1_7/${options.handle_token}`;
    bus.send({ type: METHOD_RETURN, replySerial: call.serial, sender: PORTAL_OWNER, signature: 'o', body: [request] });
    return () => bus.signal(PORTAL_OWNER, request, 'org.freedesktop.portal.Request', 'Response', 'ua{sv}', [0, results]);
  };
  const handle = (call: DBusMessage) => {
    calls.push(call);
    const reply = (signature = '', body: unknown[] = []) =>
      bus.send({ type: METHOD_RETURN, replySerial: call.serial, sender: 'org.freedesktop.DBus', signature, body });
    if (call.member === 'Hello') reply('s', [':1.7']);
    else if (call.member === 'Get') reply('v', [['u', 1]]);
    else if (call.member === 'GetNameOwner') reply('s', [PORTAL_OWNER]);
    else if (call.member === 'CreateSession') respond(call, { session_handle: ['s', SESSION] })();
    else if (call.member === 'BindShortcuts') {
      const answer = respond(call, {
        shortcuts: ['a(sa{sv})', (call.body[1] as Array<[string]>).map(([id]) => [id, { trigger_description: ['s', `${id} key`] }])],
      });
      if (bus.answerBinds) answer();
    } else reply();
    for (const waiter of waiters) if (count(waiter.member) >= waiter.times) waiter.resolve();
  };
  bus.server = createServer((socket) => {
    client = socket;
    socket.on('error', () => undefined); // the client may hang up before our last reply
    let inbox = Buffer.alloc(0);
    let authenticated = false;
    socket.on('data', (chunk: Buffer) => {
      inbox = Buffer.concat([inbox, chunk]);
      if (!authenticated) {
        const text = inbox.toString('latin1');
        if (text.includes('AUTH') && !text.includes('BEGIN\r\n')) {
          if (text.endsWith('\r\n')) socket.write('OK 0123456789abcdef\r\n');
          return;
        }
        if (!text.includes('BEGIN\r\n')) return;
        inbox = inbox.subarray(text.indexOf('BEGIN\r\n') + 7);
        authenticated = true;
      }
      while (inbox.length >= 16) {
        const headerEnd = 16 + inbox.readUInt32LE(12);
        const length = headerEnd + ((8 - (headerEnd % 8)) % 8) + inbox.readUInt32LE(4);
        if (inbox.length < length) break;
        const message = decodeMessage(inbox.subarray(0, length));
        inbox = inbox.subarray(length);
        handle(message);
      }
    });
  });
  await new Promise<void>((resolve) => bus.server!.listen(path, resolve));
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path}`;
  return { bus, calls };
}

let openServer: Server | undefined;
afterEach(() => {
  openServer?.close();
  openServer = undefined;
});

async function openPortal() {
  const { bus, calls } = await fakePortalBus();
  openServer = bus.server;
  const events = { onShortcut: mock(), onLost: mock(), onTriggers: mock() };
  const portal = await openGlobalShortcutsPortal(events);
  return { bus, calls, events, portal };
}

const CTRL_SPACE = { keyCode: 0x20, modifiers: ['ctrl' as const] };
const shortcutSignal = (member: string, id: string): [string, string, string, unknown[]] =>
  ['org.freedesktop.portal.GlobalShortcuts', member, 'osta{sv}', [SESSION, id, 0n, {}]];

describe('GlobalShortcuts portal session', () => {
  it('accepts shortcut signals only from the portal unique name', async () => {
    const { bus, events, portal } = await openPortal();
    expect(await portal.bind({ dictation: CTRL_SPACE })).toEqual({ dictation: 'dictation key' });

    const delivered = new Promise((resolve) => events.onShortcut.mockImplementation(resolve));
    bus.signal(':1.99', SESSION, ...shortcutSignal('Activated', 'dictation')); // unicast spoof
    bus.signal(PORTAL_OWNER, SESSION, ...shortcutSignal('Activated', 'agent')); // not bound
    bus.signal(PORTAL_OWNER, SESSION, ...shortcutSignal('Activated', 'dictation'));
    await delivered;
    expect(events.onShortcut.mock.calls).toEqual([['dictation', true]]);
    portal.close();
  });

  it('releases a held chord before replacing the session on rebind', async () => {
    const { bus, events, portal } = await openPortal();
    await portal.bind({ dictation: CTRL_SPACE });
    const pressed = new Promise((resolve) => events.onShortcut.mockImplementation(resolve));
    bus.signal(PORTAL_OWNER, SESSION, ...shortcutSignal('Activated', 'dictation'));
    await pressed;

    const rebinding = portal.bind({ dictation: CTRL_SPACE, agent: { keyCode: 0x20, modifiers: ['alt'] } });
    expect(events.onShortcut.mock.calls).toEqual([['dictation', true], ['dictation', false]]);
    await rebinding;
    portal.close();
  });

  it('rejects a bind waiting on the user dialog when closed, and when the desktop revokes the session', async () => {
    const { bus, events, portal } = await openPortal();
    bus.answerBinds = false;
    const revoked = portal.bind({ dictation: CTRL_SPACE });
    await bus.called('BindShortcuts');
    bus.signal(PORTAL_OWNER, SESSION, 'org.freedesktop.portal.Session', 'Closed', 'a{sv}', [{}]);
    await expect(revoked).rejects.toThrow('closed the shortcut session');
    expect(events.onTriggers).toHaveBeenCalledWith({ dictation: null });

    const closing = portal.bind({ agent: CTRL_SPACE });
    await bus.called('BindShortcuts', 2);
    // Signals arrive in order, so once this one lands the BindShortcuts call has
    // returned and only its Response (the user dialog) is outstanding.
    const changed = new Promise((resolve) => events.onTriggers.mockImplementation(resolve));
    bus.signal(PORTAL_OWNER, SESSION, 'org.freedesktop.portal.GlobalShortcuts', 'ShortcutsChanged', 'oa(sa{sv})', [SESSION, []]);
    await changed;
    portal.close();
    await expect(closing).rejects.toThrow('portal is closed');
    expect(events.onLost).not.toHaveBeenCalled();
  });

  it('reports loss and rejects pending work when the portal leaves the bus', async () => {
    const { bus, events, portal } = await openPortal();
    bus.answerBinds = false;
    const pending = portal.bind({ dictation: CTRL_SPACE });
    await bus.called('BindShortcuts');
    bus.signal(':1.99', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', 'sss',
      ['org.freedesktop.portal.Desktop', PORTAL_OWNER, '']); // spoofed: ignored
    bus.signal('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', 'sss',
      ['org.freedesktop.portal.Desktop', PORTAL_OWNER, '']);
    await expect(pending).rejects.toThrow('went away');
    expect(events.onLost).toHaveBeenCalledTimes(1);
  });
});

describe('D-Bus reader limits', () => {
  it('rejects an array of zero-size elements instead of spinning forever', () => {
    const message = encodeMessage({
      type: SIGNAL, serial: 1, path: '/', interface: 'a.b', member: 'C', signature: 'a()t', body: [[], 0n],
    });
    // Claim 8 bytes of empty structs: each element reads nothing, so the cursor never advances.
    message.writeUInt32LE(8, message.length - 16);
    expect(() => decodeMessage(message)).toThrow('no size');
  });
});

describe('D-Bus wire format', () => {
  it('round-trips a BindShortcuts call with nested structs, dicts, and variants', () => {
    const shortcuts = [
      ['dictation', { description: ['s', 'Dictation'], preferred_trigger: ['s', 'CTRL+space'] }],
      ['agent', { description: ['s', 'Agent Mode'] }],
    ];
    const encoded = encodeMessage({
      type: METHOD_CALL,
      serial: 7,
      destination: 'org.freedesktop.portal.Desktop',
      path: '/org/freedesktop/portal/desktop',
      interface: 'org.freedesktop.portal.GlobalShortcuts',
      member: 'BindShortcuts',
      signature: 'oa(sa{sv})sa{sv}',
      body: ['/org/freedesktop/portal/desktop/session/1_2/s', shortcuts, '', { handle_token: ['s', 't1'] }],
    });

    expect(decodeMessage(encoded)).toMatchObject({
      type: METHOD_CALL,
      serial: 7,
      member: 'BindShortcuts',
      body: [
        '/org/freedesktop/portal/desktop/session/1_2/s',
        [
          ['dictation', { description: 'Dictation', preferred_trigger: 'CTRL+space' }],
          ['agent', { description: 'Agent Mode' }],
        ],
        '',
        { handle_token: 't1' },
      ],
    });
  });
});

describe('GlobalShortcuts portal triggers', () => {
  it('describes chords in the XDG shortcuts format and leaves modifier-only chords to the desktop', () => {
    expect(preferredTrigger({ keyCode: 0x20, modifiers: ['ctrl', 'shift'] })).toBe('CTRL+SHIFT+space');
    expect(preferredTrigger({ keyCode: 0x52, modifiers: ['win'] })).toBe('LOGO+r');
    expect(preferredTrigger({ keyCode: 0x7b, modifiers: [] })).toBe('F12');
    expect(preferredTrigger({ keyCode: null, modifiers: ['ctrl', 'win'] })).toBeUndefined();
  });
});

/**
 * A pc105 evdev keymap as the server reports it: base keysym per keycode and
 * the modifier rows Shift, Lock, Control, Mod1–Mod5. Xorg also puts virtual
 * keycodes (204 Alt_L, 206 Super_L) on rows with NoSymbol as their base keysym.
 */
function keymap(overrides: Record<number, number> = {}, rows: Partial<Record<number, number[]>> = {}): X11Keymap {
  const keysyms = new Map<number, number>([
    [37, 0xffe3], [105, 0xffe4], [50, 0xffe1], [62, 0xffe2], [64, 0xffe9], [108, 0xfe03], [133, 0xffeb], [134, 0xffec],
    [66, 0xffe5], [77, 0xff7f], [65, 0x20], [55, 0x76], [60, 0x2e], [34, 0x5b], [204, 0], [206, 0],
  ]);
  for (const [keycode, keysym] of Object.entries(overrides)) keysyms.set(Number(keycode), keysym);
  const modifiers = [[50, 62], [66], [37, 105], [64, 204], [77], [], [133, 134, 206], [108]];
  for (const [row, keycodes] of Object.entries(rows)) modifiers[Number(row)] = keycodes ?? [];
  return { keysyms, modifiers };
}
const CTRL_V = { keyCode: 0x56, modifiers: ['ctrl' as const] };

describe('X11 key grabs', () => {
  it('grabs a modifier-only chord on each of its keys so pressing either last fires it', () => {
    expect(x11Grabs('dictation', { keyCode: null, modifiers: ['ctrl', 'win'] }, keymap())).toEqual([
      { intent: 'dictation', keycode: 37, modifiers: 64 }, // Control_L with Super held
      { intent: 'dictation', keycode: 105, modifiers: 64 }, // Control_R
      { intent: 'dictation', keycode: 133, modifiers: 4 }, // Super_L with Ctrl held
      { intent: 'dictation', keycode: 134, modifiers: 4 }, // Super_R
    ]);
    expect(x11Grabs('agent', { keyCode: 0x20, modifiers: ['alt'] }, keymap())).toEqual([
      { intent: 'agent', keycode: 65, modifiers: 8 },
    ]);
  });

  it('grabs the key that types the bound letter, not its QWERTY position', () => {
    // Dvorak: the QWERTY V position (55) types k, and v sits where QWERTY has '.' (60).
    const dvorak = keymap({ 55: 0x6b, 60: 0x76 });
    expect(x11Grabs('dictation', CTRL_V, dvorak)).toEqual([{ intent: 'dictation', keycode: 60, modifiers: 4 }]);
  });

  it('leaves a key the layout lacks unassigned instead of guessing its position', () => {
    // German: the QWERTY '[' position types ü, and no key types '[' unshifted.
    expect(x11Grabs('dictation', { keyCode: 0xdb, modifiers: ['ctrl'] }, keymap({ 34: 0xfc }))).toEqual([]);
  });

  it('uses the modifier rows the server reports', () => {
    // Super moved to Mod3, as some xmodmap setups do.
    const superOnMod3 = keymap({}, { 5: [133, 134], 6: [] });
    expect(x11Grabs('dictation', { keyCode: 0x56, modifiers: ['win'] }, superOnMod3)).toEqual([
      { intent: 'dictation', keycode: 55, modifiers: 32 },
    ]);
    // Super on no row cannot be told apart from no Super at all.
    expect(x11Grabs('dictation', { keyCode: 0x56, modifiers: ['win'] }, keymap({}, { 6: [206] }))).toEqual([]);
    // Alt sharing Num Lock's row would be ignored as a lock state.
    expect(x11Grabs('agent', { keyCode: 0x20, modifiers: ['alt'] }, keymap({}, { 3: [], 4: [77, 64] }))).toEqual([]);
    // Alt and Super on one row would fire Alt+Space for Super+Space.
    expect(x11Grabs('agent', { keyCode: 0x20, modifiers: ['alt', 'win'] }, keymap({}, { 3: [64, 133, 134] }))).toEqual([]);
  });

  it('reads the MIT cookie for this display from Xauthority', () => {
    const entry = (number: string, name: string, data: string) => {
      const parts = [Buffer.from('host'), Buffer.from(number), Buffer.from(name), Buffer.from(data)];
      return Buffer.concat([
        Buffer.from([0x01, 0x00]),
        ...parts.flatMap((part) => [Buffer.from([part.length >> 8, part.length & 0xff]), part]),
      ]);
    };
    const file = Buffer.concat([
      entry('1', 'MIT-MAGIC-COOKIE-1', 'other-display'),
      entry('0', 'XDM-AUTHORIZATION-1', 'wrong-scheme'),
      entry('0', 'MIT-MAGIC-COOKIE-1', 'this-display'),
    ]);
    expect(xauthCookie(file, '0')?.toString()).toBe('this-display');
    expect(xauthCookie(file, '2')).toBeNull();
  });
});
