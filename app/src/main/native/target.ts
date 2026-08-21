import koffi from 'koffi';
import type { DictationTargetSnapshot } from '../../types/ipc';

export interface TargetCaptureDeps {
  getForegroundWindow: () => bigint;
  getWindowThreadProcessId: (hwnd: bigint, processIdBuf: Buffer) => bigint;
  getClassName: (hwnd: bigint, classNameBuf: Buffer, maxCount: number) => number;
  openProcess: (desiredAccess: number, inheritHandle: boolean, processId: number) => bigint;
  queryFullProcessImageName: (handle: bigint, flags: number, exeNameBuf: Buffer, sizeBuf: Buffer) => boolean;
  getProcessCreationTime: (
    handle: bigint,
    creationTimeBuf: Buffer,
    exitTimeBuf: Buffer,
    kernelTimeBuf: Buffer,
    userTimeBuf: Buffer,
  ) => boolean;
  closeHandle: (handle: bigint) => boolean;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

function fileTimeToIsoString(low: number, high: number): string {
  const fileTime = BigInt(high) << 32n | BigInt(low >>> 0);
  const windowsEpochOffsetMs = 11644473600000n;
  const milliseconds = fileTime / 10000n - windowsEpochOffsetMs;
  return new Date(Number(milliseconds)).toISOString();
}

export function createTargetCapture(deps: TargetCaptureDeps): () => DictationTargetSnapshot | null {
  return function captureForegroundTarget(): DictationTargetSnapshot | null {
    const hwnd = Number(deps.getForegroundWindow());
    if (!hwnd) return null;

    const processIdBuf = Buffer.alloc(4);
    const threadId = Number(deps.getWindowThreadProcessId(BigInt(hwnd), processIdBuf));
    const processId = processIdBuf.readUInt32LE(0);
    if (!processId) return null;

    const classNameBuf = Buffer.alloc(512);
    const classNameLen = deps.getClassName(BigInt(hwnd), classNameBuf, 256);
    const windowClass = classNameLen > 0 ? classNameBuf.toString('utf16le', 0, classNameLen * 2) : '';

    let executablePath: string | null = null;
    let processCreationTime = '';
    const processHandle = Number(deps.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId));
    if (processHandle) {
      const exeNameBuf = Buffer.alloc(1024);
      const sizeBuf = Buffer.alloc(4);
      sizeBuf.writeUInt32LE(512, 0);
      if (deps.queryFullProcessImageName(BigInt(processHandle), 0, exeNameBuf, sizeBuf)) {
        const size = sizeBuf.readUInt32LE(0);
        executablePath = exeNameBuf.toString('utf16le', 0, size * 2);
      }
      const creationTimeBuf = Buffer.alloc(8);
      const exitTimeBuf = Buffer.alloc(8);
      const kernelTimeBuf = Buffer.alloc(8);
      const userTimeBuf = Buffer.alloc(8);
      if (deps.getProcessCreationTime(
        BigInt(processHandle),
        creationTimeBuf,
        exitTimeBuf,
        kernelTimeBuf,
        userTimeBuf,
      )) {
        processCreationTime = fileTimeToIsoString(
          creationTimeBuf.readUInt32LE(0),
          creationTimeBuf.readUInt32LE(4),
        );
      }
      deps.closeHandle(BigInt(processHandle));
    }

    if (!processCreationTime) return null;

    return {
      hwnd,
      processId,
      processCreationTime,
      threadId,
      windowClass,
      executablePath,
      capturedAt: new Date().toISOString(),
    };
  };
}

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
const GetWindowThreadProcessId = user32.func(
  'uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hWnd, uint32_t * lpdwProcessId)'
);
const GetClassNameW = user32.func(
  'int32_t __stdcall GetClassNameW(uintptr_t hWnd, char16_t * lpClassName, int32_t nMaxCount)'
);
const OpenProcess = kernel32.func(
  'uintptr_t __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)'
);
const QueryFullProcessImageNameW = kernel32.func(
  'bool __stdcall QueryFullProcessImageNameW(uintptr_t hProcess, uint32_t dwFlags, char16_t * lpExeName, uint32_t * lpdwSize)'
);
const GetProcessTimes = kernel32.func(
  'bool __stdcall GetProcessTimes(uintptr_t hProcess, void * lpCreationTime, void * lpExitTime, void * lpKernelTime, void * lpUserTime)'
);
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(uintptr_t hObject)');

const realDeps: TargetCaptureDeps = {
  getForegroundWindow: () => GetForegroundWindow() as bigint,
  getWindowThreadProcessId: (hwnd, processIdBuf) =>
    GetWindowThreadProcessId(hwnd, processIdBuf) as bigint,
  getClassName: (hwnd, classNameBuf, maxCount) =>
    Number(GetClassNameW(hwnd, classNameBuf, maxCount)),
  openProcess: (desiredAccess, inheritHandle, processId) =>
    OpenProcess(desiredAccess, inheritHandle, processId) as bigint,
  queryFullProcessImageName: (handle, flags, exeNameBuf, sizeBuf) =>
    QueryFullProcessImageNameW(handle, flags, exeNameBuf, sizeBuf) as boolean,
  getProcessCreationTime: (handle, creationTimeBuf, exitTimeBuf, kernelTimeBuf, userTimeBuf) =>
    GetProcessTimes(handle, creationTimeBuf, exitTimeBuf, kernelTimeBuf, userTimeBuf) as boolean,
  closeHandle: (handle) => CloseHandle(handle) as boolean,
};

export const captureForegroundTarget = createTargetCapture(realDeps);
