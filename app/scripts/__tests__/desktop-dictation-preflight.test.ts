import { expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { collectReport, describeDeviceTypes, interpretBusctl } from '../desktop-dictation-preflight';

// Replies below were captured from busctl 262 against xdg-desktop-portal 1.22.1 (KDE 6.8.2).
const failed = (stderr: string) => ({ status: 1, stdout: '', stderr, error: undefined });
const integration = process.env.SHUDDHALEKHAN_PREFLIGHT_INTEGRATION === '1';

test('busctl property replies parse into portal versions and device masks', () => {
  expect(interpretBusctl({ status: 0, stdout: 'u 2\n', stderr: '', error: undefined })).toEqual({ status: 'available', value: 2 });
  const devices = interpretBusctl({ status: 0, stdout: 'u 7\n', stderr: '', error: undefined });
  expect(devices.status === 'available' && describeDeviceTypes(devices.value)).toEqual(['keyboard', 'pointer', 'touchscreen']);
  expect(describeDeviceTypes(2)).toEqual(['pointer']);
  // A non-numeric reply is never reported as an available version.
  expect(interpretBusctl({ status: 0, stdout: 's "kde"\n', stderr: '', error: undefined }).status).toBe('error');
  expect(interpretBusctl({ status: 0, stdout: 'u 4294967296\n', stderr: '', error: undefined }).status).toBe('error');
});

test('busctl failures are reported by cause instead of thrown', () => {
  expect(interpretBusctl(failed('Failed to get property version on interface org.freedesktop.portal.Nope: No such interface “org.freedesktop.portal.Nope”')).status).toBe('missing-interface');
  expect(interpretBusctl(failed('Failed to get property NoProp on interface org.freedesktop.portal.RemoteDesktop: No such property “NoProp”')).status).toBe('missing-property');
  expect(interpretBusctl(failed('Failed to get property version on interface org.freedesktop.portal.Clipboard: The name is not activatable')).status).toBe('portal-not-running');
  expect(interpretBusctl(failed('Failed to set bus address: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined')).status).toBe('no-session-bus');
  expect(interpretBusctl(failed('')).status).toBe('error');
});

test.skipIf(!integration)('a missing or hung command becomes busctl-missing or timeout', () => {
  expect(interpretBusctl(spawnSync('shuddhalekhan-no-such-busctl', [], { encoding: 'utf8' })).status).toBe('busctl-missing');
  const hung = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { encoding: 'utf8', timeout: 100, killSignal: 'SIGKILL' });
  expect(interpretBusctl(hung).status).toBe('timeout');
});

test.skipIf(!integration || process.platform !== 'linux')('without a session bus the report is honest about every portal', () => {
  const report = collectReport({ PATH: process.env.PATH });
  expect(report.session?.sessionBusAddressSet).toBe(false);
  for (const portal of report.portals ?? []) expect(['no-session-bus', 'busctl-missing']).toContain(portal.status);
});
