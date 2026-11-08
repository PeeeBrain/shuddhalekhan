import type { RecordingIntent, ShortcutBinding } from '../../types/ipc';
import { ordinaryKeyByCode } from '../../shared/shortcut-keys';
import { DBusConnection, type DBusMessage, type Variant } from './dbus';
import type { LinuxShortcutBackend, LinuxShortcutBindings, LinuxShortcutEvents, LinuxShortcutTriggers } from './linux-shortcuts';

const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const GLOBAL_SHORTCUTS = 'org.freedesktop.portal.GlobalShortcuts';
const BUS = 'org.freedesktop.DBus';
const BUS_PATH = '/org/freedesktop/DBus';
/** Matches the installed `shuddhalekhan.desktop`, which is how desktops name the app in their shortcut UI. */
const APP_ID = 'shuddhalekhan';

const DESCRIPTIONS: Record<RecordingIntent, string> = {
  dictation: 'Dictation',
  agent: 'Agent Mode',
};

const MODIFIER_TRIGGER = { ctrl: 'CTRL', alt: 'ALT', shift: 'SHIFT', win: 'LOGO' } as const;

// XKB keysym names for keys whose keycap name is not already one.
const KEYSYM: Record<string, string> = {
  Backspace: 'BackSpace', Enter: 'Return', Space: 'space', 'Page Up': 'Page_Up', 'Page Down': 'Page_Down',
  ';': 'semicolon', '=': 'equal', ',': 'comma', '-': 'minus', '.': 'period', '/': 'slash', '`': 'grave',
  '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright', "'": 'apostrophe', '<': 'less',
};

/**
 * Portal `preferred_trigger` text (XDG shortcuts spec), e.g. `CTRL+SHIFT+space`.
 * Modifier-only chords have no spec form, so they return undefined and the
 * desktop asks the user to pick a trigger.
 */
export function preferredTrigger(binding: ShortcutBinding): string | undefined {
  const key = binding.keyCode === null ? undefined : ordinaryKeyByCode(binding.keyCode)?.name;
  if (key === undefined) return undefined;
  const keysym = KEYSYM[key] ?? (key.length === 1 ? key.toLowerCase() : key);
  return [...binding.modifiers.map((modifier) => MODIFIER_TRIGGER[modifier]), keysym].join('+');
}

function isRecordingIntent(value: unknown): value is RecordingIntent {
  return value === 'dictation' || value === 'agent';
}

/** Per-intent trigger descriptions from a portal `a(sa{sv})` shortcuts list. */
function readTriggers(intents: RecordingIntent[], shortcuts: unknown): LinuxShortcutTriggers {
  const assigned = new Map(
    ((shortcuts ?? []) as Array<[string, Record<string, unknown>]>).map(([id, info]) => [id, info?.trigger_description]),
  );
  return Object.fromEntries(intents.map((intent) => {
    const description = assigned.get(intent);
    return [intent, typeof description === 'string' && description.length > 0 ? description : null];
  }));
}

export async function openGlobalShortcutsPortal({ onShortcut, onLost, onTriggers }: LinuxShortcutEvents): Promise<LinuxShortcutBackend> {
  const bus = await DBusConnection.openSession();
  let owner: string;
  try {
    // Host (unsandboxed) apps must name themselves before their first portal
    // call; older portals lack the registry and fall back to the app's cgroup.
    await bus.call(PORTAL, PORTAL_PATH, 'org.freedesktop.host.portal.Registry', 'Register', 'sa{sv}', [APP_ID, {}])
      .catch(() => undefined);
    const [version] = await bus.call(PORTAL, PORTAL_PATH, 'org.freedesktop.DBus.Properties', 'Get', 'ss', [GLOBAL_SHORTCUTS, 'version']);
    if (typeof version !== 'number' || version < 1) throw new Error('GlobalShortcuts portal is unavailable');
    await bus.call(BUS, BUS_PATH, BUS, 'AddMatch', 's', [`type='signal',sender='${PORTAL}'`]);
    await bus.call(BUS, BUS_PATH, BUS, 'AddMatch', 's', [
      `type='signal',sender='${BUS}',interface='${BUS}',member='NameOwnerChanged',arg0='${PORTAL}'`,
    ]);
    // Unicast signals reach us whatever the match rules say; only the portal's
    // own unique name may speak for it.
    owner = String((await bus.call(BUS, BUS_PATH, BUS, 'GetNameOwner', 's', [PORTAL]))[0]);
  } catch (error) {
    bus.close();
    // oxlint-disable-next-line preserve-caught-error -- the message carries the cause; the ES2020 lib has no Error cause option.
    throw new Error(`GlobalShortcuts portal is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const responses = new Map<string, { resolve: (response: [number, Record<string, unknown>]) => void; reject: (error: Error) => void }>();
  const held = new Set<RecordingIntent>();
  let tokens = 0;
  let session: string | null = null;
  let boundKey: string | null = null;
  let intents: RecordingIntent[] = [];
  let triggers: LinuxShortcutTriggers = {};
  let done = false;

  const rejectResponses = (error: Error) => {
    for (const { reject } of responses.values()) reject(error);
    responses.clear();
  };
  /** Ends every held chord: its Deactivated can no longer be trusted to arrive. */
  const releaseHeld = () => {
    for (const intent of [...held]) {
      held.delete(intent);
      onShortcut(intent, false);
    }
  };
  const lose = () => {
    if (done) return;
    done = true;
    rejectResponses(new Error('The GlobalShortcuts portal went away'));
    held.clear(); // the caller releases everything it holds on loss
    bus.close();
    onLost();
  };

  bus.onSignal((message: DBusMessage) => {
    if (message.sender === BUS && message.member === 'NameOwnerChanged') {
      if (message.body[0] === PORTAL && message.body[2] !== owner) lose();
      return;
    }
    if (message.sender !== owner) return;
    if (message.interface === 'org.freedesktop.portal.Request' && message.member === 'Response' && message.path) {
      const waiter = responses.get(message.path);
      responses.delete(message.path);
      waiter?.resolve([Number(message.body[0]), (message.body[1] ?? {}) as Record<string, unknown>]);
      return;
    }
    if (message.interface === 'org.freedesktop.portal.Session' && message.member === 'Closed') {
      if (!session || message.path !== session) return;
      // The desktop revoked the session; a new bind (which may prompt) waits for the next shortcut change.
      session = null;
      boundKey = null;
      releaseHeld();
      rejectResponses(new Error('The desktop closed the shortcut session'));
      triggers = Object.fromEntries(intents.map((intent) => [intent, null]));
      onTriggers(triggers);
      return;
    }
    if (message.interface !== GLOBAL_SHORTCUTS || !session || message.body[0] !== session) return;
    if (message.member === 'ShortcutsChanged') {
      releaseHeld();
      triggers = readTriggers(intents, message.body[1]);
      onTriggers(triggers);
      return;
    }
    const id = message.body[1];
    if (!isRecordingIntent(id) || !intents.includes(id)) return;
    if (message.member === 'Activated') {
      held.add(id);
      onShortcut(id, true);
    } else if (message.member === 'Deactivated' && held.delete(id)) {
      onShortcut(id, false);
    }
  });
  bus.onClose(lose);

  /** Calls a portal method that answers through a Request object's Response signal. */
  async function request(
    method: string,
    signature: string,
    args: unknown[],
    options: Record<string, Variant>,
  ): Promise<Record<string, unknown>> {
    if (done) throw new Error('The GlobalShortcuts portal is closed');
    const token = `shuddhalekhan${++tokens}`;
    const path = `${PORTAL_PATH}/request/${bus.uniqueName.slice(1).replace(/\./g, '_')}/${token}`;
    // No deadline: BindShortcuts may sit behind a user dialog. Loss, close, and
    // session revocation reject it instead.
    const response = new Promise<[number, Record<string, unknown>]>((resolve, reject) => {
      responses.set(path, { resolve, reject });
    });
    response.catch(() => undefined); // it may reject before the call returns and we await it

    try {
      await bus.call(PORTAL, PORTAL_PATH, GLOBAL_SHORTCUTS, method, signature, [...args, { ...options, handle_token: ['s', token] }]);
    } catch (error) {
      responses.delete(path);
      throw error;
    }
    const [code, results] = await response;
    if (code === 1) throw new Error(`${method} was cancelled`);
    if (code !== 0) throw new Error(`${method} failed`);
    return results;
  }

  function closeSession(): void {
    releaseHeld();
    if (session) {
      void bus.call(PORTAL, session, 'org.freedesktop.portal.Session', 'Close').catch(() => undefined);
    }
    session = null;
  }

  return {
    kind: 'portal',
    async bind(bindings: LinuxShortcutBindings) {
      const key = JSON.stringify(bindings);
      if (key === boundKey) return triggers;
      // Each bind is a fresh session: portals bind a session's shortcuts once.
      closeSession();
      boundKey = null;
      triggers = {};
      const entries = Object.entries(bindings) as Array<[RecordingIntent, ShortcutBinding]>;
      intents = entries.map(([intent]) => intent);
      if (entries.length === 0) {
        boundKey = key;
        return triggers;
      }
      const created = await request('CreateSession', 'a{sv}', [], {
        session_handle_token: ['s', `shuddhalekhan_session${tokens}`],
      });
      const handle = created.session_handle;
      if (typeof handle !== 'string') throw new Error('CreateSession returned no session');
      session = handle;
      const shortcuts = entries.map(([intent, binding]) => {
        const trigger = preferredTrigger(binding);
        return [intent, {
          description: ['s', DESCRIPTIONS[intent]],
          ...(trigger ? { preferred_trigger: ['s', trigger] } : {}),
        }];
      });
      const bound = await request('BindShortcuts', 'oa(sa{sv})sa{sv}', [handle, shortcuts, ''], {});
      triggers = readTriggers(intents, bound.shortcuts);
      boundKey = key;
      return triggers;
    },
    // The portal exposes no key state; Deactivated says only that the desktop
    // considers the chord over, not that every modifier is up.
    keysHeld: async () => null,
    close() {
      if (done) return;
      done = true;
      held.clear(); // the caller drops its own held state when it closes us
      closeSession();
      rejectResponses(new Error('The GlobalShortcuts portal is closed'));
      bus.close();
    },
  };
}
