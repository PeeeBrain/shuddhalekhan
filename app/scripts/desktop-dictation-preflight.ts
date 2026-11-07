// Opt-in, read-only desktop diagnostic for Dictation delivery feasibility (#240).
//   bun scripts/desktop-dictation-preflight.ts [--json]
// Reports OS/session facts and which xdg-desktop-portal interfaces the session bus exposes.
// It only reads D-Bus properties (with auto-start off): no portal sessions, dialogs, clipboard,
// audio, input, or environment dumps. Availability is not support certification.
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { arch, release } from 'os';
import { join } from 'path';

const PORTAL_DEST = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const COMMAND_TIMEOUT_MS = 3000;
const DESKTOP_ID = 'shuddhalekhan.desktop';
// ScreenCast and InputCapture are context only; neither is required for keyboard-only delivery.
const PORTAL_PROPERTIES = [
  ['GlobalShortcuts', 'version'],
  ['RemoteDesktop', 'version'],
  ['RemoteDesktop', 'AvailableDeviceTypes'],
  ['Clipboard', 'version'],
  ['InputCapture', 'version'],
  ['ScreenCast', 'version'],
] as const;
const DEVICE_TYPES = [[1, 'keyboard'], [2, 'pointer'], [4, 'touchscreen']] as const;

export type PropertyResult =
  | { status: 'available'; value: number }
  | { status: 'missing-interface' | 'missing-property' | 'portal-not-running' | 'no-session-bus' | 'busctl-missing' | 'timeout' | 'error'; detail: string };

/** Classifies one `busctl get-property` run. These portal properties are uint32 values. */
export function interpretBusctl(result: Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>): PropertyResult {
  const error = result.error;
  if (error && 'code' in error && error.code === 'ENOENT') return { status: 'busctl-missing', detail: 'busctl not found on PATH' };
  if (error && 'code' in error && error.code === 'ETIMEDOUT') return { status: 'timeout', detail: `no reply within ${COMMAND_TIMEOUT_MS} ms` };
  if (error) return { status: 'error', detail: error.message };
  const stderr = (result.stderr ?? '').trim();
  if (result.status === 0) {
    const match = /^u (\d+)$/.exec((result.stdout ?? '').trim());
    const value = match ? Number(match[1]) : NaN;
    return Number.isInteger(value) && value <= 0xffffffff
      ? { status: 'available', value }
      : { status: 'error', detail: `unexpected reply: ${(result.stdout ?? '').trim().slice(0, 80)}` };
  }
  if (/No such interface/.test(stderr)) return { status: 'missing-interface', detail: stderr };
  if (/No such property/.test(stderr)) return { status: 'missing-property', detail: stderr };
  if (/not activatable|ServiceUnknown|NameHasNoOwner|not provided by any \.service/.test(stderr)) {
    return { status: 'portal-not-running', detail: stderr };
  }
  if (/bus address|Failed to connect|DBUS_SESSION_BUS_ADDRESS/.test(stderr)) return { status: 'no-session-bus', detail: stderr };
  return { status: 'error', detail: stderr || `busctl exited ${result.status}` };
}

export function describeDeviceTypes(mask: number) {
  return DEVICE_TYPES.filter(([bit]) => mask & bit).map(([, name]) => name);
}

function readPortalProperty(iface: string, property: string, env: NodeJS.ProcessEnv) {
  // Fixed argv, no shell: nothing from the environment is interpolated.
  return interpretBusctl(spawnSync('busctl', [
    '--user', '--auto-start=no', 'get-property', PORTAL_DEST, PORTAL_PATH, `org.freedesktop.portal.${iface}`, property,
  ], { encoding: 'utf8', env: { ...env, LC_ALL: 'C' }, timeout: COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }));
}

function installedElectronVersion() {
  try {
    const metadata: unknown = JSON.parse(readFileSync(join(import.meta.dir, '..', 'node_modules', 'electron', 'package.json'), 'utf8'));
    return metadata !== null && typeof metadata === 'object' && 'version' in metadata && typeof metadata.version === 'string'
      ? metadata.version : null;
  } catch {
    return null;
  }
}

function findDesktopEntry(env: NodeJS.ProcessEnv) {
  const dataDirs = [
    env.XDG_DATA_HOME || (env.HOME ? join(env.HOME, '.local/share') : ''),
    ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':'),
  ].filter(Boolean);
  return dataDirs.map((dir) => join(dir, 'applications', DESKTOP_ID)).find((path) => existsSync(path)) ?? null;
}

export function collectReport(env = process.env) {
  const linux = process.platform === 'linux';
  return {
    os: { platform: process.platform, arch: arch(), kernel: release() },
    runtime: { bun: process.versions.bun ?? null, node: process.versions.node, installedElectron: installedElectronVersion() },
    session: linux
      ? {
          type: env.XDG_SESSION_TYPE ?? null,
          currentDesktop: env.XDG_CURRENT_DESKTOP ?? null,
          sessionDesktop: env.XDG_SESSION_DESKTOP ?? null,
          waylandDisplaySet: Boolean(env.WAYLAND_DISPLAY),
          x11DisplaySet: Boolean(env.DISPLAY),
          sessionBusAddressSet: Boolean(env.DBUS_SESSION_BUS_ADDRESS || env.XDG_RUNTIME_DIR),
        }
      : null,
    desktopEntry: linux ? { id: DESKTOP_ID, installedAt: findDesktopEntry(env) } : null,
    portals: linux
      ? PORTAL_PROPERTIES.map(([iface, property]) => ({ iface, property, ...readPortalProperty(iface, property, env) }))
      : null,
  };
}

function printText(report: ReturnType<typeof collectReport>) {
  const lines = [
    'Desktop Dictation preflight (read-only; availability is not certification)',
    `OS: ${report.os.platform} ${report.os.arch} ${report.os.kernel}`,
    `Runtime: bun ${report.runtime.bun ?? 'n/a'}, node ${report.runtime.node}, installed electron ${report.runtime.installedElectron ?? 'not found'}`,
  ];
  if (report.session) {
    const s = report.session;
    lines.push(
      `Session: type=${s.type ?? 'unset'} desktop=${s.currentDesktop ?? 'unset'} WAYLAND_DISPLAY=${s.waylandDisplaySet ? 'set' : 'unset'} DISPLAY=${s.x11DisplaySet ? 'set' : 'unset'}`,
      `Desktop entry ${report.desktopEntry?.id}: ${report.desktopEntry?.installedAt ?? 'not installed in XDG data dirs'}`,
      'Portal interfaces on the session bus:',
    );
    for (const p of report.portals ?? []) {
      const value = p.status !== 'available'
        ? `${p.status} (${p.detail})`
        : p.property === 'AvailableDeviceTypes' ? `${p.value} [${describeDeviceTypes(p.value).join(', ') || 'none'}]` : String(p.value);
      lines.push(`  ${p.iface}.${p.property}: ${value}`);
    }
  } else {
    lines.push('Portal probe skipped: not Linux.');
  }
  console.log(lines.join('\n'));
}

if (import.meta.main) {
  const report = collectReport();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printText(report);
}
