import { describe, expect, it, mock } from 'bun:test';
import { KdeWaylandDelivery } from '../kde-wayland-delivery';
import { getAutomaticDeliveryError } from '../dictation-delivery-policy';
import type { PasteStrategy } from '../../types/ipc';

const ORIGINAL = { windowId: 'win-1', epoch: 7, appId: 'org.kde.konsole' };

function harness(options: { setup?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  let focus = { ...ORIGINAL };
  let sessionAlive = true;
  let trackerAlive = true;
  const tracker = {
    capture: mock(() => ({ ...focus })),
    validate: mock((snapshot: typeof ORIGINAL) => snapshot.windowId === focus.windowId && snapshot.epoch === focus.epoch),
    isAlive: () => trackerAlive,
    close: mock(async () => { calls.push('tracker-close'); }),
  };
  const paste = mock(async (strategy: PasteStrategy, _signal: AbortSignal, validateTarget: () => boolean) => {
    calls.push(`paste:${strategy}:${validateTarget()}`);
    return { acceptedEvents: 4 } as { acceptedEvents: number; error?: string };
  });
  const keyboard = {
    setup: mock(options.setup ?? (async () => { calls.push('consent'); })),
    isReady: () => sessionAlive,
    paste,
    close: mock(async () => { calls.push('keyboard-close'); }),
  };
  const released = { value: true };
  const delivery = new KdeWaylandDelivery({
    createTracker: async () => { calls.push('tracker'); return tracker; },
    createKeyboard: () => keyboard,
    waitForShortcutRelease: async () => { calls.push('release'); return released.value; },
    stageClipboard: async (text) => { calls.push(`clipboard:${text}`); },
    getPasteStrategy: (appId) => appId === 'org.kde.konsole' ? 'ctrl-shift-v' : 'ctrl-v',
    onChange: () => calls.push(`status:${delivery.status().state}`),
  });
  return {
    delivery, calls, tracker, keyboard, paste, released,
    moveFocus: (next: Partial<typeof ORIGINAL>) => { focus = { ...focus, ...next }; },
    loseSession: () => { sessionAlive = false; },
    loseTracker: () => { trackerAlive = false; },
  };
}

async function readyHarness() {
  const h = harness();
  expect(await h.delivery.enable()).toBe('ready');
  const target = h.delivery.capture();
  if (target?.kind !== 'kde-wayland') throw new Error('expected a KDE target');
  h.calls.length = 0;
  return { ...h, target };
}

describe('KDE Wayland best-effort delivery', () => {
  it('keeps Wayland blocked unless the best-effort mode is ready', () => {
    const env = { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' };
    expect(getAutomaticDeliveryError('linux', env)).toContain('unavailable on Wayland');
    expect(getAutomaticDeliveryError('linux', env, true)).toBeNull();
  });

  it('reports ready only after window tracking and keyboard consent both succeed', async () => {
    const { delivery, calls } = harness();
    expect(delivery.capture()).toBeNull();
    expect(delivery.status().state).toBe('off');

    expect(await delivery.enable()).toBe('ready');
    expect(calls).toEqual(['status:setting-up', 'tracker', 'consent', 'status:ready']);
    expect(delivery.isReady()).toBe(true);
    expect(delivery.capture()).toMatchObject({ kind: 'kde-wayland', ...ORIGINAL });
  });

  it('stays unavailable and closes the tracker when keyboard control is denied', async () => {
    const { delivery, calls } = harness({ setup: async () => { throw new Error('User cancelled.'); } });

    expect(await delivery.enable()).toBe('failed');
    expect(delivery.isReady()).toBe(false);
    expect(delivery.capture()).toBeNull();
    expect(delivery.status()).toEqual({
      state: 'unavailable',
      message: 'Keyboard control was not granted: User cancelled. Automatic insertion stays off; Last Transcript still works.',
    });
    expect(calls).toContain('tracker-close');
    expect(calls).toContain('keyboard-close');
  });

  it('closes a session still awaiting consent when turned off, and never reports it ready', async () => {
    let grant: (() => void) | undefined;
    const { delivery, calls } = harness({ setup: () => new Promise<void>((resolve) => { grant = resolve; }) });
    const pending = delivery.enable();
    for (let i = 0; i < 20 && !grant; i++) await Promise.resolve();
    if (!grant) throw new Error('consent prompt never started');

    await delivery.disable();
    grant();
    expect(await pending).toBe('superseded');
    expect(calls).toContain('keyboard-close');
    expect(delivery.status().state).toBe('off');
    expect(delivery.isReady()).toBe(false);
  });

  it('lets a disable that arrives while re-setup is closing the old session win', async () => {
    const { delivery, calls } = await readyHarness();

    const pending = delivery.enable();
    await delivery.disable();

    expect(await pending).toBe('superseded');
    expect(calls).not.toContain('tracker');
    expect(delivery.status().state).toBe('off');
  });

  it('reports a lost keyboard-control session and stops capturing targets', async () => {
    const { delivery, loseSession, target } = await readyHarness();
    loseSession();

    expect(delivery.status().state).toBe('unavailable');
    expect(delivery.capture()).toBeNull();
    expect(await delivery.deliver('hi', target, new AbortController().signal)).toMatchObject({ kind: 'input-blocked' });
  });

  it('stops claiming ready when KWin window tracking dies', async () => {
    const { delivery, loseTracker, target, paste } = await readyHarness();
    loseTracker();

    expect(delivery.isReady()).toBe(false);
    expect(delivery.status()).toMatchObject({ state: 'unavailable', message: expect.stringContaining('window tracking stopped') });
    expect(delivery.capture()).toBeNull();
    expect(await delivery.deliver('hi', target, new AbortController().signal)).toMatchObject({ kind: 'input-blocked' });
    expect(paste).not.toHaveBeenCalled();
  });

  it('releases the shortcut, validates, stages the clipboard, then pastes with the app strategy', async () => {
    const { delivery, calls, target } = await readyHarness();

    const result = await delivery.deliver('hello', target, new AbortController().signal);

    expect(result).toEqual({ kind: 'input-dispatched', acceptedEvents: 4 });
    expect(calls).toEqual(['release', 'clipboard:hello', 'paste:ctrl-shift-v:true']);
  });

  it('pastes nothing and leaves the clipboard alone when the original window lost focus', async () => {
    const { delivery, calls, moveFocus, paste, target } = await readyHarness();
    moveFocus({ windowId: 'win-2' });

    expect(await delivery.deliver('hello', target, new AbortController().signal)).toMatchObject({ kind: 'target-changed' });
    expect(calls).toEqual(['release']);
    expect(paste).not.toHaveBeenCalled();
  });

  it('pastes nothing while the recording shortcut is still held', async () => {
    const { delivery, calls, paste, released, target } = await readyHarness();
    released.value = false;

    expect(await delivery.deliver('hello', target, new AbortController().signal)).toMatchObject({ kind: 'input-blocked', acceptedEvents: 0 });
    expect(calls).toEqual(['release']);
    expect(paste).not.toHaveBeenCalled();
  });

  it('does not paste after cancellation', async () => {
    const { delivery, paste, target } = await readyHarness();
    const abort = new AbortController();
    abort.abort();

    expect(await delivery.deliver('hello', target, abort.signal)).toMatchObject({ kind: 'input-blocked' });
    expect(paste).not.toHaveBeenCalled();
  });

  it('reports a partial dispatch as uncertain and does not retry it', async () => {
    const { delivery, paste, target } = await readyHarness();
    paste.mockImplementationOnce(async () => ({ acceptedEvents: 2, error: 'Focus changed.' }));

    const result = await delivery.deliver('hello', target, new AbortController().signal);

    expect(result.kind).toBe('error');
    expect(paste).toHaveBeenCalledTimes(1);
  });
});
