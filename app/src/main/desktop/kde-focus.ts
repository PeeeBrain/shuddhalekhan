import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DBusConnection, type DBusMessage } from './dbus';

const KWIN = 'org.kde.KWin';
const BUS = 'org.freedesktop.DBus';
const BUS_PATH = '/org/freedesktop/DBus';
const PATH = '/dev/shuddhalekhan/KdeFocus';
const IFACE = 'dev.shuddhalekhan.KdeFocus';
const READY_TIMEOUT_MS = 5000;
// Fixed so the next setup unloads a script a crashed run left behind (the single-instance lock keeps it unique).
const PLUGIN_NAME = 'shuddhalekhan-focus';
// Process-wide so a snapshot from a closed tracker never matches a later tracker's epoch.
let epoch = 0;

/** The window that was active at `capture`; `epoch` counts every activation KWin reported. */
export interface KdeFocusSnapshot {
  readonly windowId: string;
  readonly epoch: number;
  /** desktopFileName, else resourceClass; may be empty. */
  readonly appId: string;
}

export interface KdeFocusTracker {
  /** The active window now, or null when it is unknown (no window, KWin lost, closed). */
  capture(): KdeFocusSnapshot | null;
  /** True only while no activation at all has happened since `snapshot` was captured. */
  validate(snapshot: KdeFocusSnapshot): boolean;
  /** False once KWin or the bus went away, or after close(). */
  isAlive(): boolean;
  close(): Promise<void>;
}

/** KWin JS: reports the active window now and on every activation, from KWin's own bus connection. */
function kwinScript(destination: string): string {
  const target = [destination, PATH, IFACE, 'Changed'].map((part) => JSON.stringify(part)).join(', ');
  return `function report(w) {
  callDBus(${target}, w ? String(w.internalId) : '', w ? String(w.desktopFileName || w.resourceClass || '') : '');
}
workspace.windowActivated.connect(report);
report(workspace.activeWindow);
`;
}

/**
 * Tracks the active window on KDE Plasma (Wayland or X11) through a transient
 * KWin script that lives only as long as this tracker. Fails closed: any loss
 * of the bus or KWin makes every snapshot invalid and `capture` return null.
 * ponytail: a window activated between capture and the caller's paste can still
 * race the notification; callers accept that residual window.
 * `onLost` fires once if tracking dies after setup succeeded (not on close()).
 * ponytail: if the app crashes, its script stays loaded (calling a dead bus name on
 * each activation) until the next setup or a KWin restart unloads it.
 */
export async function createKdeFocusTracker(onLost?: () => void): Promise<KdeFocusTracker> {
  const bus = await DBusConnection.openSession();
  const dir = await mkdtemp(join(tmpdir(), 'shuddhalekhan-kwin-')).catch((error) => {
    bus.close();
    throw error;
  });
  const pluginName = PLUGIN_NAME;
  let tracking = false;
  let owner = '';
  let windowId = '';
  let appId = '';
  let alive = true;
  let loaded = false;
  let ready: () => void = () => undefined;
  let failed: (error: Error) => void = () => undefined;
  const firstReport = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  firstReport.catch(() => undefined);
  const removeDir = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);

  const lose = () => {
    if (!alive) return;
    alive = false;
    windowId = '';
    failed(new Error('KWin focus tracking was lost'));
    bus.close();
    void removeDir();
    if (tracking) onLost?.();
  };

  bus.onClose(lose);
  bus.onSignal((message: DBusMessage) => {
    if (message.sender === BUS && message.member === 'NameOwnerChanged' && message.body[0] === KWIN && message.body[2] !== owner) {
      lose();
    }
  });
  bus.onMethodCall((call) => {
    if (call.path !== PATH || call.interface !== IFACE || call.member !== 'Changed') return;
    // The bus daemon stamps `sender`; only KWin's own connection speaks for the active window.
    if (!owner || call.sender !== owner) {
      bus.reply(call, 's', ['Only KWin may report focus'], 'org.freedesktop.DBus.Error.AccessDenied');
      return;
    }
    bus.reply(call);
    if (!alive) return;
    const [id, app] = call.body;
    epoch += 1;
    windowId = typeof id === 'string' ? id : '';
    appId = typeof app === 'string' ? app : '';
    ready();
  });

  try {
    await bus.call(BUS, BUS_PATH, BUS, 'AddMatch', 's', [
      `type='signal',sender='${BUS}',interface='${BUS}',member='NameOwnerChanged',arg0='${KWIN}'`,
    ]);
    owner = String((await bus.call(BUS, BUS_PATH, BUS, 'GetNameOwner', 's', [KWIN]))[0]);
    const file = join(dir, 'focus.js');
    await writeFile(file, kwinScript(bus.uniqueName), { mode: 0o600 });
    await bus.call(KWIN, '/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', [pluginName]);
    const [id] = await bus.call(KWIN, '/Scripting', 'org.kde.kwin.Scripting', 'loadScript', 'ss', [file, pluginName]);
    if (typeof id !== 'number' || id < 0) throw new Error('KWin refused to load the focus script');
    loaded = true;
    await bus.call(KWIN, `/Scripting/Script${id}`, 'org.kde.kwin.Script', 'run');
    // KWin reads the file asynchronously after run(); the first report proves it has.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      firstReport,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('KWin focus script never reported')), READY_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    await removeDir();
    tracking = true;
  } catch (error) {
    if (loaded) await bus.call(KWIN, '/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', [pluginName]).catch(() => undefined);
    lose();
    // oxlint-disable-next-line preserve-caught-error -- the message carries the cause; the ES2020 lib has no Error cause option.
    throw new Error(`KWin focus tracking is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    capture: () => (alive && windowId ? Object.freeze({ windowId, epoch, appId }) : null),
    validate: (snapshot) => alive && windowId !== '' && snapshot.epoch === epoch && snapshot.windowId === windowId,
    isAlive: () => alive,
    async close() {
      if (!alive) return;
      alive = false;
      tracking = false;
      windowId = '';
      await bus.call(KWIN, '/Scripting', 'org.kde.kwin.Scripting', 'unloadScript', 's', [pluginName]).catch(() => undefined);
      bus.close();
      await removeDir();
    },
  };
}
