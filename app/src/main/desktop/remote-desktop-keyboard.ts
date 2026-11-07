import type { PasteStrategy } from '../../types/ipc';
import { DBusConnection, type DBusMessage, type Variant } from './dbus';

const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const REMOTE_DESKTOP = 'org.freedesktop.portal.RemoteDesktop';
const BUS = 'org.freedesktop.DBus';
const BUS_PATH = '/org/freedesktop/DBus';
/** Matches the installed `shuddhalekhan.desktop`, which is how the desktop names us in its consent dialog. */
const APP_ID = 'shuddhalekhan';
const KEYBOARD = 1;

// X11 keysyms. The compositor resolves each through the active layout, so `v`
// needs a layout that has a `v` key (Latin layouts; not e.g. a lone Cyrillic one).
const XK_SHIFT_L = 0xffe1;
const XK_CONTROL_L = 0xffe3;
const XK_INSERT = 0xff63;
const XK_V = 0x0076;

/** Keys pressed in order and released in reverse, mirroring `buildPasteStrategyEvents`. */
const PASTE_KEYS: Record<PasteStrategy, number[]> = {
  'ctrl-v': [XK_CONTROL_L, XK_V],
  'shift-insert': [XK_SHIFT_L, XK_INSERT],
  'ctrl-shift-v': [XK_CONTROL_L, XK_SHIFT_L, XK_V],
};

/** Already user-readable; setup() rethrows it as-is instead of wrapping it. */
class RemoteDesktopError extends Error {}

export interface PasteResult {
  /** Notify calls the portal accepted, releases included. Says nothing about what the target app did. */
  acceptedEvents: number;
  error?: string;
}

/**
 * Keyboard-only xdg-desktop-portal RemoteDesktop session for pasting on Wayland.
 * `setup()` is the only path that can show the desktop's consent dialog; `paste()`
 * never starts a session. The session lives in memory until close() or loss
 * (no restore token), so each app launch asks again.
 */
export function createRemoteDesktopKeyboard(onLost?: () => void) {
  let bus: DBusConnection | null = null;
  let owner = '';
  let session: string | null = null;
  let ready = false;
  let closed = false;
  let pasting = false;
  let tokens = 0;
  let setupRun: Promise<void> | null = null;
  const responses = new Map<string, { resolve: (response: [number, Record<string, unknown>]) => void; reject: (error: Error) => void }>();

  /** Drops the session and connection; pending requests reject with `message`. */
  const teardown = (message: string) => {
    const wasReady = ready;
    ready = false;
    session = null;
    for (const { reject } of responses.values()) reject(new RemoteDesktopError(message));
    responses.clear();
    bus?.close();
    bus = null;
    if (wasReady) onLost?.();
  };

  const onSignal = (connection: DBusConnection) => (message: DBusMessage) => {
    if (connection !== bus) return;
    if (message.sender === BUS && message.member === 'NameOwnerChanged') {
      if (message.body[0] === PORTAL && message.body[2] !== owner) teardown('The desktop portal went away');
      return;
    }
    // Unicast signals reach us whatever the match rules say; only the portal's unique name may speak for it.
    if (!owner || message.sender !== owner) return;
    if (message.interface === 'org.freedesktop.portal.Request' && message.member === 'Response' && message.path) {
      const waiter = responses.get(message.path);
      responses.delete(message.path);
      waiter?.resolve([Number(message.body[0]), (message.body[1] ?? {}) as Record<string, unknown>]);
    } else if (message.interface === 'org.freedesktop.portal.Session' && message.member === 'Closed' && session && message.path === session) {
      teardown('The desktop closed the remote desktop session');
    }
  };

  /** Calls a portal method that answers through a Request object's Response signal. */
  async function request(connection: DBusConnection, method: string, signature: string, args: unknown[], options: Record<string, Variant>) {
    const token = `shuddhalekhan_rd${++tokens}`;
    const path = `${PORTAL_PATH}/request/${connection.uniqueName.slice(1).replace(/\./g, '_')}/${token}`;
    // No deadline: Start sits behind the consent dialog. close() and loss reject it.
    const response = new Promise<[number, Record<string, unknown>]>((resolve, reject) => responses.set(path, { resolve, reject }));
    response.catch(() => undefined); // it may reject before the call returns and we await it
    try {
      await connection.call(PORTAL, PORTAL_PATH, REMOTE_DESKTOP, method, signature, [...args, { ...options, handle_token: ['s', token] }]);
    } catch (error) {
      responses.delete(path);
      throw error;
    }
    const [code, results] = await response;
    if (code === 1) throw new RemoteDesktopError(`${method} was cancelled by the user`);
    if (code !== 0) throw new RemoteDesktopError(`${method} failed`);
    return results;
  }

  async function start(): Promise<void> {
    let connection: DBusConnection;
    try {
      connection = await DBusConnection.openSession();
    } catch (error) {
      throw new RemoteDesktopError(`Session bus is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (closed) {
      connection.close();
      throw new RemoteDesktopError('Remote desktop keyboard was closed during setup');
    }
    bus = connection;
    owner = '';
    connection.onSignal(onSignal(connection));
    connection.onClose(() => {
      if (connection === bus) teardown('The session bus connection closed');
    });
    try {
      // Host apps must name themselves before their first portal call; older portals lack the registry.
      await connection.call(PORTAL, PORTAL_PATH, 'org.freedesktop.host.portal.Registry', 'Register', 'sa{sv}', [APP_ID, {}])
        .catch(() => undefined);
      const [types] = await connection.call(PORTAL, PORTAL_PATH, 'org.freedesktop.DBus.Properties', 'Get', 'ss', [REMOTE_DESKTOP, 'AvailableDeviceTypes']);
      if (typeof types !== 'number' || !(types & KEYBOARD)) throw new RemoteDesktopError('The desktop offers no remote keyboard');
      await connection.call(BUS, BUS_PATH, BUS, 'AddMatch', 's', [`type='signal',sender='${PORTAL}'`]);
      await connection.call(BUS, BUS_PATH, BUS, 'AddMatch', 's', [
        `type='signal',sender='${BUS}',interface='${BUS}',member='NameOwnerChanged',arg0='${PORTAL}'`,
      ]);
      owner = String((await connection.call(BUS, BUS_PATH, BUS, 'GetNameOwner', 's', [PORTAL]))[0]);

      const created = await request(connection, 'CreateSession', 'a{sv}', [], { session_handle_token: ['s', `shuddhalekhan_rd_session${tokens}`] });
      if (typeof created.session_handle !== 'string') throw new RemoteDesktopError('CreateSession returned no session');
      session = created.session_handle;
      await request(connection, 'SelectDevices', 'oa{sv}', [session], { types: ['u', KEYBOARD] });
      const started = await request(connection, 'Start', 'osa{sv}', [session, ''], {});
      if (!(Number(started.devices) & KEYBOARD)) throw new RemoteDesktopError('The keyboard was not granted');
      ready = true;
    } catch (error) {
      if (connection === bus) {
        if (session) void connection.call(PORTAL, session, 'org.freedesktop.portal.Session', 'Close').catch(() => undefined);
        teardown('Remote desktop setup failed');
      }
      if (error instanceof RemoteDesktopError) throw error;
      throw new RemoteDesktopError(`RemoteDesktop portal is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    /** Opens the consent dialog when no session is live. Call only from an explicit user action. */
    setup(): Promise<void> {
      if (closed) return Promise.reject(new RemoteDesktopError('Remote desktop keyboard is closed'));
      if (ready) return Promise.resolve();
      setupRun ??= start().finally(() => { setupRun = null; });
      return setupRun;
    },

    isReady: () => ready,

    /**
     * Presses the strategy's keys through the live session. Checks abort, session,
     * and `validateTarget` before every press; on any stop it releases every key it
     * pressed and returns the error. Never retries and never starts a session.
     */
    async paste(strategy: PasteStrategy, signal: AbortSignal, validateTarget: () => boolean): Promise<PasteResult> {
      if (!ready || !bus || !session) return { acceptedEvents: 0, error: 'Remote desktop session is not ready' };
      if (pasting) return { acceptedEvents: 0, error: 'A paste is already in progress' };
      pasting = true;
      const connection = bus;
      const handle = session;
      const notify = (keysym: number, pressed: boolean) =>
        connection.call(PORTAL, PORTAL_PATH, REMOTE_DESKTOP, 'NotifyKeyboardKeysym', 'oa{sv}iu', [handle, {}, keysym, pressed ? 1 : 0]);
      const keys = PASTE_KEYS[strategy];
      const held: number[] = [];
      let acceptedEvents = 0;
      let error: string | undefined;
      try {
        for (const keysym of keys) {
          error = signal.aborted ? 'Paste was aborted'
            : session !== handle ? 'Remote desktop session was lost'
            : !validateTarget() ? 'Paste target changed' : undefined;
          if (error) break;
          // Held before the await: a failed press may still have reached the compositor.
          held.push(keysym);
          try {
            await notify(keysym, true);
            acceptedEvents++;
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
            break;
          }
        }
      } finally {
        // Releases go out whatever stopped us: a stuck modifier is worse than a missed paste.
        for (const keysym of held.reverse()) {
          try {
            await notify(keysym, false);
            acceptedEvents++;
          } catch (cause) {
            error ??= cause instanceof Error ? cause.message : String(cause);
          }
        }
        pasting = false;
      }
      return error ? { acceptedEvents, error } : { acceptedEvents };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Dropping the connection also ends the session: the portal closes sessions whose peer leaves the bus.
      if (bus && session) void bus.call(PORTAL, session, 'org.freedesktop.portal.Session', 'Close').catch(() => undefined);
      teardown('Remote desktop keyboard was closed');
    },
  };
}

export type RemoteDesktopKeyboard = ReturnType<typeof createRemoteDesktopKeyboard>;
