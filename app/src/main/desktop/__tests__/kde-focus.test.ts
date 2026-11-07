import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'fs';
import { createServer, type Server, type Socket } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { decodeMessage, encodeMessage, METHOD_CALL, SIGNAL, type DBusMessage, type OutgoingMessage } from '../dbus';
// Main's orchestration tests mock this module process-wide; load the real one.
const { createKdeFocusTracker }: typeof import('../kde-focus') = await import(`../kde-focus?test=${Date.now()}`);

const METHOD_RETURN = 2;
const CLIENT = ':1.7';
const KWIN_OWNER = ':1.2';

/** A session bus with a scripted KWin behind it, on a private socket: nothing touches the host compositor. */
async function fakeKwinBus() {
  const path = join(mkdtempSync(join(tmpdir(), 'fake-bus-')), 'bus');
  const calls: DBusMessage[] = [];
  const replies = new Map<number, (message: DBusMessage) => void>();
  let client: Socket | undefined;
  let serial = 100;
  const kwin = { scriptFile: '', scriptMode: 0, script: '' };
  const send = (message: Omit<OutgoingMessage, 'serial'>) => {
    const sent = ++serial;
    client?.write(encodeMessage({ serial: sent, ...message }));
    return sent;
  };
  /** Delivers `Changed` from `sender`; resolves with the tracker's reply, so the update is applied. */
  const report = (sender: string, windowId: string, appId = 'org.kde.konsole') => new Promise<DBusMessage>((resolve) => {
    replies.set(send({
      type: METHOD_CALL, sender, destination: CLIENT, path: '/dev/shuddhalekhan/KdeFocus',
      interface: 'dev.shuddhalekhan.KdeFocus', member: 'Changed', signature: 'ss', body: [windowId, appId],
    }), resolve);
  });
  const handle = (message: DBusMessage) => {
    if (message.type !== METHOD_CALL) {
      replies.get(message.replySerial!)?.(message);
      return;
    }
    calls.push(message);
    const reply = (signature = '', body: unknown[] = []) =>
      send({ type: METHOD_RETURN, replySerial: message.serial, destination: CLIENT, signature, body });
    if (message.member === 'Hello') reply('s', [CLIENT]);
    else if (message.member === 'GetNameOwner') reply('s', [KWIN_OWNER]);
    else if (message.member === 'loadScript') {
      kwin.scriptFile = String(message.body[0]);
      reply('i', [3]);
    } else if (message.member === 'run') {
      kwin.scriptMode = statSync(kwin.scriptFile).mode & 0o777;
      kwin.script = readFileSync(kwin.scriptFile, 'utf8');
      reply();
      void report(KWIN_OWNER, '{original}');
    } else if (message.member === 'unloadScript') reply('b', [true]);
    else reply();
  };
  let hangUp = () => undefined as void;
  /** Resolves when the tracker drops its bus connection. */
  const hungUp = new Promise<void>((resolve) => { hangUp = resolve; });
  const server = createServer((socket) => {
    client = socket;
    socket.on('close', hangUp);
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
        handle(decodeMessage(inbox.subarray(0, length)));
        inbox = inbox.subarray(length);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path}`;
  const signal = (body: unknown[]) => send({
    type: SIGNAL, sender: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged', signature: 'sss', body,
  });
  return { server, calls, kwin, report, signal, hungUp };
}

let openServer: Server | undefined;
afterEach(() => {
  openServer?.close();
  openServer = undefined;
});

async function openTracker() {
  const bus = await fakeKwinBus();
  openServer = bus.server;
  let lost = 0;
  const tracker = await createKdeFocusTracker(() => { lost += 1; });
  return { ...bus, tracker, lostCount: () => lost };
}

describe('KDE focus tracker', () => {
  it('loads a private transient script and captures the initial active window', async () => {
    const { tracker, kwin } = await openTracker();
    expect(kwin.scriptMode).toBe(0o600);
    expect(kwin.script).toContain(JSON.stringify(CLIENT));
    expect(existsSync(dirname(kwin.scriptFile))).toBe(false);
    expect(tracker.capture()).toEqual({ windowId: '{original}', epoch: 1, appId: 'org.kde.konsole' });
    await tracker.close();
  });

  it('invalidates on any activation, and returning to the original window does not revive it', async () => {
    const { tracker, report } = await openTracker();
    const snapshot = tracker.capture()!;
    expect(tracker.validate(snapshot)).toBe(true);
    await report(KWIN_OWNER, '{other}', 'firefox');
    expect(tracker.validate(snapshot)).toBe(false);
    await report(KWIN_OWNER, '{original}');
    expect(tracker.validate(snapshot)).toBe(false);
    expect(tracker.validate(tracker.capture()!)).toBe(true);
    await tracker.close();
  });

  it('rejects reports from anyone but KWin', async () => {
    const { tracker, report } = await openTracker();
    const snapshot = tracker.capture()!;
    const reply = await report(':1.66', '{other}');
    expect(reply.errorName).toBe('org.freedesktop.DBus.Error.AccessDenied');
    expect(tracker.validate(snapshot)).toBe(true);
    await tracker.close();
  });

  it('fails closed when KWin leaves the bus', async () => {
    const { tracker, signal, hungUp, lostCount } = await openTracker();
    const snapshot = tracker.capture()!;
    signal(['org.kde.KWin', KWIN_OWNER, '']);
    await hungUp;
    expect(tracker.validate(snapshot)).toBe(false);
    expect(tracker.capture()).toBeNull();
    expect(tracker.isAlive()).toBe(false);
    expect(lostCount()).toBe(1);
    await tracker.close();
    expect(lostCount()).toBe(1);
  });

  it('unloads a leftover script before loading, and unloads its own on close', async () => {
    const { tracker, calls, lostCount } = await openTracker();
    const snapshot = tracker.capture()!;
    await tracker.close();
    expect(tracker.validate(snapshot)).toBe(false);
    expect(tracker.capture()).toBeNull();
    expect(lostCount()).toBe(0);
    const name = calls.find((call) => call.member === 'loadScript')!.body[1];
    const scripting = calls.filter((call) => call.member === 'unloadScript' || call.member === 'loadScript');
    expect(scripting.map((call) => [call.member, call.body.at(-1)])).toEqual([['unloadScript', name], ['loadScript', name], ['unloadScript', name]]);
  });
});
