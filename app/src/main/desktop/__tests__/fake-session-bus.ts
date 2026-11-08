import { mkdtempSync } from 'fs';
import { createServer, type Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { decodeMessage, encodeMessage, type DBusMessage, type OutgoingMessage } from '../dbus';

export const METHOD_RETURN = 2;
export const ERROR = 3;

export type Send = (message: Omit<OutgoingMessage, 'serial'>) => number;

/**
 * A session bus on a private unix socket, so nothing touches the host desktop.
 * Accepts any auth, frames messages, hands each one to `handle`, and points
 * DBUS_SESSION_BUS_ADDRESS at itself. `send` returns the serial it used.
 */
export async function fakeSessionBus(handle: (message: DBusMessage, send: Send) => void) {
  const path = join(mkdtempSync(join(tmpdir(), 'fake-bus-')), 'bus');
  let client: Socket | undefined;
  let serial = 100;
  const send: Send = (message) => {
    const sent = ++serial;
    client?.write(encodeMessage({ serial: sent, ...message }));
    return sent;
  };
  let hangUp = () => undefined as void;
  /** Resolves when the client drops its connection. */
  const hungUp = new Promise<void>((resolve) => { hangUp = resolve; });
  const server = createServer((socket) => {
    client = socket;
    socket.on('close', hangUp);
    socket.on('error', () => undefined); // the client may hang up before our last reply
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
        handle(message, send);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path}`;
  return { server, send, hungUp };
}
