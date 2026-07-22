import { beforeEach, describe, expect, it, mock } from 'bun:test';

const vi = { fn: mock };
let captureTarget: ReturnType<typeof import('../../native/target').createTargetCapture>;

describe('target capture', () => {
  beforeEach(async () => {
    const { createTargetCapture } = await import(`../../native/target?test=${Date.now()}-${Math.random()}`);
    captureTarget = createTargetCapture({
      getForegroundWindow: vi.fn(() => BigInt(12345)),
      getWindowThreadProcessId: vi.fn((_hwnd: bigint, pidBuf: Buffer) => {
        pidBuf.writeUInt32LE(67890, 0);
        return BigInt(111);
      }),
      getClassName: vi.fn((_hwnd: bigint, buf: Buffer, _maxCount: number) => {
        const name = 'Notepad';
        buf.write(name, 'utf16le');
        return name.length;
      }),
      openProcess: vi.fn(() => BigInt(999)),
      queryFullProcessImageName: vi.fn((_hProcess: bigint, _flags: number, buf: Buffer, sizeBuf: Buffer) => {
        const exe = 'C:\\Windows\\notepad.exe';
        buf.write(exe, 'utf16le');
        sizeBuf.writeUInt32LE(exe.length, 0);
        return true;
      }),
      closeHandle: vi.fn(() => true),
    });
  });

  it('returns a snapshot for the current foreground window', () => {
    const result = captureTarget();

    expect(result).toEqual({
      hwnd: 12345,
      processId: 67890,
      threadId: 111,
      windowClass: 'Notepad',
      executablePath: 'C:\\Windows\\notepad.exe',
      capturedAt: expect.any(String),
    });
  });

  it('returns null when there is no foreground window', async () => {
    const { createTargetCapture } = await import(`../../native/target?test=${Date.now()}-${Math.random()}`);
    const captureNoWindow = createTargetCapture({
      getForegroundWindow: vi.fn(() => BigInt(0)),
      getWindowThreadProcessId: vi.fn(),
      getClassName: vi.fn(),
      openProcess: vi.fn(),
      queryFullProcessImageName: vi.fn(),
      closeHandle: vi.fn(),
    });

    expect(captureNoWindow()).toBeNull();
  });

  it('returns null when the process ID cannot be resolved', async () => {
    const { createTargetCapture } = await import(`../../native/target?test=${Date.now()}-${Math.random()}`);
    const captureNoProcess = createTargetCapture({
      getForegroundWindow: vi.fn(() => BigInt(12345)),
      getWindowThreadProcessId: vi.fn((_hwnd: bigint, pidBuf: Buffer) => {
        pidBuf.writeUInt32LE(0, 0);
        return BigInt(0);
      }),
      getClassName: vi.fn(),
      openProcess: vi.fn(),
      queryFullProcessImageName: vi.fn(),
      closeHandle: vi.fn(),
    });

    expect(captureNoProcess()).toBeNull();
  });

  it('leaves executablePath null when the process cannot be opened', async () => {
    const { createTargetCapture } = await import(`../../native/target?test=${Date.now()}-${Math.random()}`);
    const openProcess = vi.fn(() => BigInt(0));
    const closeHandle = vi.fn(() => true);
    const captureNoExe = createTargetCapture({
      getForegroundWindow: vi.fn(() => BigInt(12345)),
      getWindowThreadProcessId: vi.fn((_hwnd: bigint, pidBuf: Buffer) => {
        pidBuf.writeUInt32LE(67890, 0);
        return BigInt(111);
      }),
      getClassName: vi.fn((_hwnd: bigint, buf: Buffer, _maxCount: number) => {
        const name = 'Notepad';
        buf.write(name, 'utf16le');
        return name.length;
      }),
      openProcess,
      queryFullProcessImageName: vi.fn(),
      closeHandle,
    });

    const result = captureNoExe();

    expect(result?.executablePath).toBeNull();
    expect(closeHandle).not.toHaveBeenCalled();
  });

  it('leaves executablePath null when the executable path query fails', async () => {
    const { createTargetCapture } = await import(`../../native/target?test=${Date.now()}-${Math.random()}`);
    const closeHandle = vi.fn(() => true);
    const captureQueryFailed = createTargetCapture({
      getForegroundWindow: vi.fn(() => BigInt(12345)),
      getWindowThreadProcessId: vi.fn((_hwnd: bigint, pidBuf: Buffer) => {
        pidBuf.writeUInt32LE(67890, 0);
        return BigInt(111);
      }),
      getClassName: vi.fn((_hwnd: bigint, buf: Buffer, _maxCount: number) => {
        const name = 'Notepad';
        buf.write(name, 'utf16le');
        return name.length;
      }),
      openProcess: vi.fn(() => BigInt(999)),
      queryFullProcessImageName: vi.fn(() => false),
      closeHandle,
    });

    const result = captureQueryFailed();

    expect(result?.executablePath).toBeNull();
    expect(closeHandle).toHaveBeenCalledWith(BigInt(999));
  });
});
