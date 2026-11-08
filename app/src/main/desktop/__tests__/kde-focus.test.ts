import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'fs';
import type { Server } from 'net';
import { dirname } from 'path';
import { METHOD_CALL, SIGNAL, type DBusMessage } from '../dbus';
import { fakeSessionBus, METHOD_RETURN, type Send } from './fake-session-bus';
// Main's orchestration tests mock this module process-wide; load the real one.
const { createKdeFocusTracker }: typeof import('../kde-focus') = await import(`../kde-focus?test=${Date.now()}`);

const CLIENT = ':1.7';
const KWIN_OWNER = ':1.2';

/** A session bus with a scripted KWin behind it. */
async function fakeKwinBus() {
  const calls: DBusMessage[] = [];
  const replies = new Map<number, (message: DBusMessage) => void>();
  const kwin = { scriptFile: '', scriptMode: 0, script: '' };
  /** Delivers `Changed` from `sender`; resolves with the tracker's reply, so the update is applied. */
  const report = (send: Send, sender: string, windowId: string, appId = 'org.kde.konsole') => new Promise<DBusMessage>((resolve) => {
    replies.set(send({
      type: METHOD_CALL, sender, destination: CLIENT, path: '/dev/shuddhalekhan/KdeFocus',
      interface: 'dev.shuddhalekhan.KdeFocus', member: 'Changed', signature: 'ss', body: [windowId, appId],
    }), resolve);
  });
  const { server, send, hungUp } = await fakeSessionBus((message, send) => {
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
      void report(send, KWIN_OWNER, '{original}');
    } else if (message.member === 'unloadScript') reply('b', [true]);
    else reply();
  });
  const signal = (body: unknown[]) => send({
    type: SIGNAL, sender: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged', signature: 'sss', body,
  });
  return { server, calls, kwin, report: report.bind(null, send), signal, hungUp };
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
    // Windows has no POSIX mode bits; the Linux CI job owns this check.
    if (process.platform !== 'win32') expect(kwin.scriptMode).toBe(0o600);
    expect(kwin.script).toContain(JSON.stringify(CLIENT));
    expect(existsSync(dirname(kwin.scriptFile))).toBe(false);
    expect(tracker.capture()).toEqual({ windowId: '{original}', epoch: expect.any(Number), appId: 'org.kde.konsole' });
    await tracker.close();
  });

  it('never validates a snapshot from an earlier tracker, even on the same window', async () => {
    const first = await openTracker();
    const snapshot = first.tracker.capture()!;
    await first.tracker.close();
    first.server.close();
    // Re-enabling insertion starts a new tracker on the same active window.
    const { tracker } = await openTracker();
    expect(tracker.validate(snapshot)).toBe(false);
    expect(tracker.validate(tracker.capture()!)).toBe(true);
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
