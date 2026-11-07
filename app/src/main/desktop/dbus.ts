import { connect, type Socket } from 'net';

/**
 * Minimal session-bus client: just enough of the D-Bus wire protocol for the
 * desktop portals (method calls, replies, signals). Little-endian only; the
 * bus daemon and portal run on this host, so that is every message we see.
 *
 * Values: s/o/g are strings, numeric types numbers (t/x bigint), arrays are
 * arrays, `a{s…}` dicts are plain objects, structs are tuples, and variants
 * are written as `[signature, value]` and read back as their bare value.
 */

export type Variant = readonly [signature: string, value: unknown];

export interface DBusMessage {
  type: number;
  serial: number;
  replySerial?: number;
  path?: string;
  interface?: string;
  member?: string;
  errorName?: string;
  sender?: string;
  body: unknown[];
}

export const METHOD_CALL = 1;
const METHOD_RETURN = 2;
const ERROR = 3;
export const SIGNAL = 4;

const ALIGN: Record<string, number> = {
  y: 1, g: 1, v: 1, n: 2, q: 2, b: 4, i: 4, u: 4, h: 4, s: 4, o: 4, a: 4, x: 8, t: 8, d: 8, '(': 8, '{': 8,
};

function typeEnd(signature: string, start: number): number {
  const c = signature[start];
  if (c === 'a') return typeEnd(signature, start + 1);
  if (c !== '(' && c !== '{') {
    if (!(c in ALIGN)) throw new Error(`Unsupported D-Bus signature "${signature}"`);
    return start + 1;
  }
  const close = c === '(' ? ')' : '}';
  let i = start + 1;
  while (signature[i] !== close) {
    if (i >= signature.length) throw new Error(`Unterminated D-Bus signature "${signature}"`);
    i = typeEnd(signature, i);
  }
  return i + 1;
}

/** Splits a signature into its complete types: `"oa(sa{sv})s"` → `["o", "a(sa{sv})", "s"]`. */
export function splitSignature(signature: string): string[] {
  const types: string[] = [];
  for (let i = 0; i < signature.length;) {
    const end = typeEnd(signature, i);
    types.push(signature.slice(i, end));
    i = end;
  }
  return types;
}

class Writer {
  buf = Buffer.alloc(256);
  len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(next);
    this.buf = next;
  }

  align(n: number): void {
    const pad = (n - (this.len % n)) % n;
    this.ensure(pad);
    this.buf.fill(0, this.len, this.len + pad);
    this.len += pad;
  }

  private bytes(data: Buffer): void {
    this.ensure(data.length + 1);
    data.copy(this.buf, this.len);
    this.buf[this.len + data.length] = 0;
    this.len += data.length + 1;
  }

  write(type: string, value: unknown): void {
    const c = type[0];
    this.align(ALIGN[c] ?? 1);
    this.ensure(8);
    switch (c) {
      case 'y': this.buf.writeUInt8(Number(value), this.len); this.len += 1; return;
      case 'b': case 'u': this.buf.writeUInt32LE(Number(value), this.len); this.len += 4; return;
      case 'i': this.buf.writeInt32LE(Number(value), this.len); this.len += 4; return;
      case 't': this.buf.writeBigUInt64LE(BigInt(value as bigint | number), this.len); this.len += 8; return;
      case 's': case 'o': {
        const data = Buffer.from(String(value));
        this.buf.writeUInt32LE(data.length, this.len);
        this.len += 4;
        this.bytes(data);
        return;
      }
      case 'g': {
        const data = Buffer.from(String(value));
        this.buf.writeUInt8(data.length, this.len);
        this.len += 1;
        this.bytes(data);
        return;
      }
      case 'v': {
        const [signature, inner] = value as Variant;
        this.write('g', signature);
        this.write(signature, inner);
        return;
      }
      case '(': {
        const items = value as unknown[];
        splitSignature(type.slice(1, -1)).forEach((member, i) => this.write(member, items[i]));
        return;
      }
      case '{': {
        const [keyType, valueType] = splitSignature(type.slice(1, -1));
        const [key, entry] = value as [unknown, unknown];
        this.write(keyType, key);
        this.write(valueType, entry);
        return;
      }
      case 'a': {
        const element = type.slice(1);
        const lengthAt = this.len;
        this.len += 4;
        this.align(ALIGN[element[0]] ?? 1);
        const start = this.len;
        const items = element[0] === '{' ? Object.entries(value as Record<string, unknown>) : value as unknown[];
        for (const item of items) this.write(element, item);
        this.buf.writeUInt32LE(this.len - start, lengthAt);
        return;
      }
      default:
        throw new Error(`Cannot write D-Bus type "${type}"`);
    }
  }

  take(): Buffer {
    return this.buf.subarray(0, this.len);
  }
}

class Reader {
  constructor(private readonly buf: Buffer, public pos: number) {}

  align(n: number): void {
    this.pos += (n - (this.pos % n)) % n;
  }

  read(type: string): unknown {
    const c = type[0];
    this.align(ALIGN[c] ?? 1);
    const at = this.pos;
    switch (c) {
      case 'y': this.pos += 1; return this.buf.readUInt8(at);
      case 'b': this.pos += 4; return this.buf.readUInt32LE(at) !== 0;
      case 'n': this.pos += 2; return this.buf.readInt16LE(at);
      case 'q': this.pos += 2; return this.buf.readUInt16LE(at);
      case 'i': this.pos += 4; return this.buf.readInt32LE(at);
      case 'u': case 'h': this.pos += 4; return this.buf.readUInt32LE(at);
      case 'x': this.pos += 8; return this.buf.readBigInt64LE(at);
      case 't': this.pos += 8; return this.buf.readBigUInt64LE(at);
      case 'd': this.pos += 8; return this.buf.readDoubleLE(at);
      case 's': case 'o': {
        const length = this.buf.readUInt32LE(at);
        this.pos = this.within(at + 4 + length + 1);
        return this.buf.toString('utf8', at + 4, at + 4 + length);
      }
      case 'g': {
        const length = this.buf.readUInt8(at);
        this.pos = this.within(at + 1 + length + 1);
        return this.buf.toString('utf8', at + 1, at + 1 + length);
      }
      case 'v': return this.read(this.read('g') as string);
      case '(': return splitSignature(type.slice(1, -1)).map((member) => this.read(member));
      case '{': return splitSignature(type.slice(1, -1)).map((member) => this.read(member));
      case 'a': {
        const length = this.buf.readUInt32LE(at);
        this.pos = at + 4;
        const element = type.slice(1);
        this.align(ALIGN[element[0]] ?? 1);
        if (length > MAX_ARRAY_LENGTH) throw new Error('D-Bus array exceeds the protocol limit');
        const end = this.within(this.pos + length);
        const items: unknown[] = [];
        while (this.pos < end) {
          const before = this.pos;
          items.push(this.read(element));
          if (this.pos <= before) throw new Error('D-Bus array element has no size');
        }
        return element[0] === '{' ? Object.fromEntries(items as [PropertyKey, unknown][]) : items;
      }
      default:
        throw new Error(`Cannot read D-Bus type "${type}"`);
    }
  }

  private within(end: number): number {
    if (end > this.buf.length) throw new Error('D-Bus value overruns its message');
    return end;
  }
}

// Protocol limits (D-Bus spec): anything larger is a broken or hostile peer.
const MAX_ARRAY_LENGTH = 64 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 128 * 1024 * 1024;
/** Method replies are bounded; portal Request responses (user dialogs) are not method replies. */
const CALL_TIMEOUT_MS = 5000;

const FIELD = { path: 1, interface: 2, member: 3, errorName: 4, replySerial: 5, destination: 6, sender: 7, signature: 8 } as const;
const FIELD_TYPE: Record<number, string> = { 1: 'o', 2: 's', 3: 's', 4: 's', 5: 'u', 6: 's', 7: 's', 8: 'g' };

export interface OutgoingMessage {
  type: number;
  serial: number;
  path?: string;
  interface?: string;
  member?: string;
  destination?: string;
  replySerial?: number;
  errorName?: string;
  sender?: string;
  signature?: string;
  body?: unknown[];
}

export function encodeMessage(message: OutgoingMessage): Buffer {
  const signature = message.signature ?? '';
  const body = new Writer();
  splitSignature(signature).forEach((type, i) => body.write(type, message.body?.[i]));

  const fields: Array<[number, Variant]> = [];
  for (const key of ['path', 'interface', 'member', 'errorName', 'destination', 'replySerial', 'sender'] as const) {
    const value = message[key];
    if (value !== undefined) fields.push([FIELD[key], [FIELD_TYPE[FIELD[key]], value]]);
  }
  if (signature) fields.push([FIELD.signature, ['g', signature]]);

  const header = new Writer();
  header.write('y', 0x6c); // 'l': little-endian
  header.write('y', message.type);
  header.write('y', 0);
  header.write('y', 1);
  header.write('u', body.len);
  header.write('u', message.serial);
  header.write('a(yv)', fields);
  header.align(8);
  return Buffer.concat([header.take(), body.take()]);
}

/** Total byte length of the message at the start of `buf`, or null when its fixed header is incomplete. */
function messageLength(buf: Buffer): number | null {
  if (buf.length < 16) return null;
  const headerEnd = 16 + buf.readUInt32LE(12);
  const length = headerEnd + ((8 - (headerEnd % 8)) % 8) + buf.readUInt32LE(4);
  if (length > MAX_MESSAGE_LENGTH) throw new Error('D-Bus message exceeds the protocol limit');
  return length;
}

export function decodeMessage(buf: Buffer): DBusMessage {
  if (buf[0] !== 0x6c) throw new Error('Big-endian D-Bus messages are not supported');
  const reader = new Reader(buf, 12);
  const fields = new Map((reader.read('a(yv)') as Array<[number, unknown]>));
  reader.align(8);
  const signature = (fields.get(FIELD.signature) as string | undefined) ?? '';
  return {
    type: buf[1],
    serial: buf.readUInt32LE(8),
    replySerial: fields.get(FIELD.replySerial) as number | undefined,
    path: fields.get(FIELD.path) as string | undefined,
    interface: fields.get(FIELD.interface) as string | undefined,
    member: fields.get(FIELD.member) as string | undefined,
    errorName: fields.get(FIELD.errorName) as string | undefined,
    sender: fields.get(FIELD.sender) as string | undefined,
    body: splitSignature(signature).map((type) => reader.read(type)),
  };
}

/** Socket path from a D-Bus address such as `unix:path=/run/user/1000/bus` (abstract sockets get a leading NUL). */
export function sessionBusSocketPath(address: string | undefined, uid: number): string {
  for (const entry of (address ?? '').split(';')) {
    if (!entry.startsWith('unix:')) continue;
    const params = new Map(entry.slice(5).split(',').map((pair) => {
      const eq = pair.indexOf('=');
      return [pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1))] as const;
    }));
    const path = params.get('path');
    if (path) return path;
    const abstract = params.get('abstract');
    if (abstract) return `\0${abstract}`;
  }
  return `/run/user/${uid}/bus`;
}

export class DBusConnection {
  uniqueName = '';
  private serial = 0;
  private inbox: Buffer = Buffer.alloc(0);
  private closed = false;
  private readonly pending = new Map<number, { resolve: (body: unknown[]) => void; reject: (error: Error) => void }>();
  private readonly signalListeners = new Set<(message: DBusMessage) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly callListeners = new Set<(message: DBusMessage) => void>();

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', (error) => console.error('D-Bus connection error:', error));
    socket.on('close', () => this.shutdown());
  }

  static async openSession(): Promise<DBusConnection> {
    const uid = process.getuid?.() ?? 0;
    const socket = connect(sessionBusSocketPath(process.env.DBUS_SESSION_BUS_ADDRESS, uid));
    // Writes before 'connect' are queued, so auth goes out as soon as the socket opens.
    socket.write(`\0AUTH EXTERNAL ${Buffer.from(String(uid)).toString('hex')}\r\n`);
    const reply = await new Promise<string>((resolve, reject) => {
      let text = '';
      const finish = (error?: Error) => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', finish);
        socket.off('close', onClose);
        if (!error) return resolve(text);
        socket.destroy();
        reject(error);
      };
      const onData = (chunk: Buffer) => {
        text += chunk.toString('latin1');
        if (text.includes('\r\n')) finish();
      };
      const onClose = () => finish(new Error('Session bus closed during authentication'));
      const timer = setTimeout(() => finish(new Error('Session bus did not answer authentication')), CALL_TIMEOUT_MS);
      socket.on('data', onData);
      socket.once('error', finish);
      socket.once('close', onClose);
    });
    if (!reply.startsWith('OK ')) {
      socket.destroy();
      throw new Error(`Session bus refused authentication: ${reply.trim()}`);
    }
    // The bus sends nothing past OK until BEGIN, so no message bytes were read above.
    socket.write('BEGIN\r\n');
    const connection = new DBusConnection(socket);
    try {
      const [name] = await connection.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'Hello');
      connection.uniqueName = String(name);
    } catch (error) {
      connection.close();
      throw error;
    }
    return connection;
  }

  call(
    destination: string,
    path: string,
    iface: string,
    member: string,
    signature = '',
    body: unknown[] = [],
  ): Promise<unknown[]> {
    if (this.closed) return Promise.reject(new Error('D-Bus connection is closed'));
    const serial = ++this.serial;
    const reply = new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(serial);
        reject(new Error(`D-Bus ${member} call timed out`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(serial, {
        resolve: (body) => { clearTimeout(timer); resolve(body); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    this.socket.write(encodeMessage({ type: METHOD_CALL, serial, destination, path, interface: iface, member, signature, body }));
    return reply;
  }

  onSignal(listener: (message: DBusMessage) => void): void {
    this.signalListeners.add(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  /** Method calls addressed to this connection; each listener must `reply` to the ones it owns. */
  onMethodCall(listener: (message: DBusMessage) => void): void {
    this.callListeners.add(listener);
  }

  /** Answers `call`; an `errorName` sends a D-Bus error with `body` as its message arguments. */
  reply(call: DBusMessage, signature = '', body: unknown[] = [], errorName?: string): void {
    if (this.closed || !call.sender) return;
    this.socket.write(encodeMessage({
      type: errorName ? ERROR : METHOD_RETURN,
      serial: ++this.serial,
      replySerial: call.serial,
      destination: call.sender,
      errorName,
      signature,
      body,
    }));
  }

  close(): void {
    this.closeListeners.clear();
    this.socket.destroy();
    this.shutdown();
  }

  private receive(chunk: Buffer): void {
    this.inbox = this.inbox.length ? Buffer.concat([this.inbox, chunk]) : chunk;
    try {
      for (let length = messageLength(this.inbox); length !== null && this.inbox.length >= length; length = messageLength(this.inbox)) {
        const message = decodeMessage(this.inbox.subarray(0, length));
        this.inbox = this.inbox.subarray(length);
        this.dispatch(message);
      }
    } catch (error) {
      // A message we cannot parse leaves the stream unframed; nothing after it is trustworthy.
      console.error('Dropping D-Bus connection after an unreadable message:', error);
      this.socket.destroy();
    }
  }

  private dispatch(message: DBusMessage): void {
    if (message.type === SIGNAL) {
      for (const listener of this.signalListeners) listener(message);
      return;
    }
    if (message.type === METHOD_CALL) {
      for (const listener of this.callListeners) listener(message);
      return;
    }
    if (message.type !== METHOD_RETURN && message.type !== ERROR) return;
    const waiter = message.replySerial === undefined ? undefined : this.pending.get(message.replySerial);
    if (!waiter) return;
    this.pending.delete(message.replySerial!);
    if (message.type === METHOD_RETURN) waiter.resolve(message.body);
    else waiter.reject(new Error(`${message.errorName}: ${String(message.body[0] ?? '')}`));
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error('D-Bus connection closed'));
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}
