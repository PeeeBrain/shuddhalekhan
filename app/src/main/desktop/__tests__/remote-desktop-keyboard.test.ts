import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'fs';
import { createServer, type Server, type Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { decodeMessage, encodeMessage, SIGNAL, type DBusMessage, type OutgoingMessage } from '../dbus';
// Main's orchestration tests mock this module process-wide; load the real one.
const { createRemoteDesktopKeyboard, RemoteDesktopError }: typeof import('../remote-desktop-keyboard') =
  await import(`../remote-desktop-keyboard?test=${Date.now()}`);

const METHOD_RETURN = 2;
const ERROR = 3;
const PORTAL_OWNER = ':1.2';
const SESSION = '/org/freedesktop/portal/desktop/session/1_7/rd';

/**
 * A session bus with a RemoteDesktop portal behind it. Start answers with
 * `startCode` only when it is set, like the consent dialog; `failKeysym`
 * makes NotifyKeyboardKeysym error for that keysym's press.
 */
async function fakePortalBus() {
  const path = join(mkdtempSync(join(tmpdir(), 'fake-bus-')), 'bus');
  const calls: DBusMessage[] = [];
  const waiters: Array<{ member: string; resolve: () => void }> = [];
  let client: Socket | undefined;
  let serial = 100;
  const bus = {
    startCode: 0 as number | null,
    failKeysym: null as number | null,
    send: (message: Omit<OutgoingMessage, 'serial'>) => client?.write(encodeMessage({ serial: ++serial, ...message })),
    signal: (sender: string, path: string, iface: string, member: string, signature: string, body: unknown[]) =>
      bus.send({ type: SIGNAL, sender, path, interface: iface, member, signature, body }),
    called: (member: string) => new Promise<void>((resolve) => {
      if (calls.some((call) => call.member === member)) resolve();
      else waiters.push({ member, resolve });
    }),
    keys: () => calls.filter((call) => call.member === 'NotifyKeyboardKeysym').map((call) => [call.body[2], call.body[3]]),
    members: () => calls.map((call) => call.member ?? ''),
    selectOptions: () => calls.find((call) => call.member === 'SelectDevices')?.body[1],
    server: undefined as Server | undefined,
  };
  const handle = (call: DBusMessage) => {
    calls.push(call);
    const reply = (signature = '', body: unknown[] = []) =>
      bus.send({ type: METHOD_RETURN, replySerial: call.serial, sender: PORTAL_OWNER, signature, body });
    const respond = (code: number, results: Record<string, unknown>) => {
      const options = call.body[call.body.length - 1] as { handle_token: string };
      const request = `/org/freedesktop/portal/desktop/request/1_7/${options.handle_token}`;
      reply('o', [request]);
      bus.signal(PORTAL_OWNER, request, 'org.freedesktop.portal.Request', 'Response', 'ua{sv}', [code, results]);
    };
    if (call.member === 'Hello') reply('s', [':1.7']);
    else if (call.member === 'Get') reply('v', [['u', 7]]);
    else if (call.member === 'GetNameOwner') reply('s', [PORTAL_OWNER]);
    else if (call.member === 'CreateSession') respond(0, { session_handle: ['s', SESSION] });
    else if (call.member === 'SelectDevices') respond(0, {});
    else if (call.member === 'Start') {
      if (bus.startCode !== null) respond(bus.startCode, { devices: ['u', 1] });
      else reply('o', ['/org/freedesktop/portal/desktop/request/1_7/pending']);
    } else if (call.member === 'NotifyKeyboardKeysym' && call.body[2] === bus.failKeysym && call.body[3] === 1) {
      bus.send({ type: ERROR, replySerial: call.serial, sender: PORTAL_OWNER, errorName: 'org.freedesktop.DBus.Error.Failed', signature: 's', body: ['nope'] });
    } else reply();
    for (const waiter of waiters.filter((w) => w.member === call.member)) waiter.resolve();
  };
  bus.server = createServer((socket) => {
    client = socket;
    socket.on('error', () => undefined);
    let inbox = Buffer.alloc(0);
    let authenticated = false;
    socket.on('data', (chunk: Buffer) => {
      inbox = Buffer.concat([inbox, chunk]);
      if (!authenticated) {
        const text = inbox.toString('latin1');
        if (!text.includes('BEGIN\r\n')) {
          if (text.endsWith('\r\n')) socket.write('OK 0123456789abcdef\r\n');
          return;
        }
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
  return bus;
}

let openServer: Server | undefined;
afterEach(() => {
  openServer?.close();
  openServer = undefined;
});

async function open(onLost?: () => void) {
  const bus = await fakePortalBus();
  openServer = bus.server;
  return { bus, keyboard: createRemoteDesktopKeyboard(onLost) };
}

const CTRL = 0xffe3;
const SHIFT = 0xffe1;
const V = 0x76;
const live = () => new AbortController().signal;

describe('RemoteDesktop keyboard session', () => {
  it('asks for a keyboard-only session and pastes ctrl-shift-v as layout keysyms', async () => {
    const { bus, keyboard } = await open();
    await keyboard.setup();
    expect(keyboard.isReady()).toBe(true);
    expect(bus.members().filter((member) => !['Hello', 'Get', 'AddMatch', 'GetNameOwner'].includes(member)))
      .toEqual(['Register', 'CreateSession', 'SelectDevices', 'Start']);
    expect(bus.selectOptions()).toMatchObject({ types: 1 });

    bus.signal(':1.99', SESSION, 'org.freedesktop.portal.Session', 'Closed', 'a{sv}', [{}]); // unicast spoof
    expect(await keyboard.paste('ctrl-shift-v', live(), () => true)).toEqual({ acceptedEvents: 6 });
    expect(bus.keys()).toEqual([[CTRL, 1], [SHIFT, 1], [V, 1], [V, 0], [SHIFT, 0], [CTRL, 0]]);
    await keyboard.close();
  });

  it('never opens the consent dialog from paste', async () => {
    const { bus, keyboard } = await open();
    expect(await keyboard.paste('ctrl-v', live(), () => true)).toMatchObject({ acceptedEvents: 0, error: expect.stringContaining('not ready') });
    expect(bus.members()).not.toContain('Start');
  });

  it('reports a dismissed consent dialog as denied', async () => {
    const { bus, keyboard } = await open();
    bus.startCode = 1;
    const failure = await keyboard.setup().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RemoteDesktopError);
    expect((failure as InstanceType<typeof RemoteDesktopError>).reason).toBe('denied');
    expect(keyboard.isReady()).toBe(false);
  });

  it('stops before the paste key and releases held modifiers when the target changes', async () => {
    const { bus, keyboard } = await open();
    await keyboard.setup();
    let checks = 0;
    const result = await keyboard.paste('ctrl-v', live(), () => ++checks === 1);
    expect(result).toEqual({ acceptedEvents: 2, error: 'Paste target changed' });
    expect(bus.keys()).toEqual([[CTRL, 1], [CTRL, 0]]);
    await keyboard.close();
  });

  it('releases every pressed key when the portal rejects a press, without retrying', async () => {
    const { bus, keyboard } = await open();
    await keyboard.setup();
    bus.failKeysym = V;
    const result = await keyboard.paste('ctrl-v', live(), () => true);
    expect(result.error).toContain('nope');
    expect(result.acceptedEvents).toBe(3);
    expect(bus.keys()).toEqual([[CTRL, 1], [V, 1], [V, 0], [CTRL, 0]]);
    await keyboard.close();
  });

  it('rejects a setup waiting on the dialog when the desktop closes the session or the app closes', async () => {
    const { bus, keyboard } = await open();
    bus.startCode = null;
    const revoked = keyboard.setup();
    await bus.called('Start');
    bus.signal(PORTAL_OWNER, SESSION, 'org.freedesktop.portal.Session', 'Closed', 'a{sv}', [{}]);
    expect(await revoked.catch((error: InstanceType<typeof RemoteDesktopError>) => error.reason)).toBe('session-lost');
    openServer?.close();

    const second = await open();
    second.bus.startCode = null;
    const cancelled = second.keyboard.setup();
    await second.bus.called('Start');
    await second.keyboard.close();
    expect(await cancelled.catch((error: InstanceType<typeof RemoteDesktopError>) => error.reason)).toBe('session-lost');
  });

  it('invalidates a live session when the portal leaves the bus', async () => {
    let lost = 0;
    const { bus, keyboard } = await open(() => { lost++; });
    await keyboard.setup();
    bus.signal('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', 'sss',
      ['org.freedesktop.portal.Desktop', PORTAL_OWNER, '']);
    for (let i = 0; i < 50 && keyboard.isReady(); i++) await new Promise((resolve) => setImmediate(resolve));
    expect(keyboard.isReady()).toBe(false);
    expect(lost).toBe(1);
    expect((await keyboard.paste('ctrl-v', live(), () => true)).acceptedEvents).toBe(0);
  });
});
