import koffi from 'koffi';

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOBOBJECTINFOCLASS_EXTENDED_LIMIT_INFORMATION = 9;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

export interface JobObjectPort {
  createKillOnCloseJob(): unknown | null;
  assign(job: unknown, pid: number): boolean;
  terminate(job: unknown): void;
}

const IoCountersType = koffi.struct('IO_COUNTERS', {
  ReadOperationCount: 'uint64_t',
  WriteOperationCount: 'uint64_t',
  OtherOperationCount: 'uint64_t',
  ReadTransferCount: 'uint64_t',
  WriteTransferCount: 'uint64_t',
  OtherTransferCount: 'uint64_t',
});

const BasicLimitInformationType = koffi.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
  PerProcessUserTimeLimit: 'int64_t',
  PerJobUserTimeLimit: 'int64_t',
  LimitFlags: 'uint32_t',
  MinimumWorkingSetSize: 'uintptr_t',
  MaximumWorkingSetSize: 'uintptr_t',
  ActiveProcessLimit: 'uint32_t',
  Affinity: 'uintptr_t',
  PriorityClass: 'uint32_t',
  SchedulingClass: 'uint32_t',
});

const ExtendedLimitInformationType = koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
  BasicLimitInformation: BasicLimitInformationType,
  IoInfo: IoCountersType,
  ProcessMemoryLimit: 'uintptr_t',
  JobMemoryLimit: 'uintptr_t',
  PeakProcessMemoryUsed: 'uintptr_t',
  PeakJobMemoryUsed: 'uintptr_t',
});

const kernel32 = koffi.load('kernel32.dll');

const CreateJobObjectW = kernel32.func(
  'uintptr_t __stdcall CreateJobObjectW(void * lpJobAttributes, char16_t * lpName)'
);
// Win32 BOOL is a 4-byte int; koffi's bool is the 1-byte C++ _Bool.
const SetInformationJobObject = kernel32.func(
  'int32_t __stdcall SetInformationJobObject(uintptr_t hJob, int32_t jobObjectInfoClass, JOBOBJECT_EXTENDED_LIMIT_INFORMATION * lpJobObjectInfo, uint32_t cbJobObjectInfoLength)'
);
const AssignProcessToJobObjectFn = kernel32.func(
  'int32_t __stdcall AssignProcessToJobObject(uintptr_t hJob, uintptr_t hProcess)'
);
const OpenProcessForContainment = kernel32.func(
  'uintptr_t __stdcall OpenProcess(uint32_t dwDesiredAccess, int32_t bInheritHandle, uint32_t dwProcessId)'
);
const TerminateJobObjectFn = kernel32.func(
  'int32_t __stdcall TerminateJobObject(uintptr_t hJob, uint32_t uExitCode)'
);
const CloseHandleFn = kernel32.func('int32_t __stdcall CloseHandle(uintptr_t hObject)');

function killOnCloseLimits(): Record<string, unknown> {
  return {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0n,
      PerJobUserTimeLimit: 0n,
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0n,
      WriteOperationCount: 0n,
      OtherOperationCount: 0n,
      ReadTransferCount: 0n,
      WriteTransferCount: 0n,
      OtherTransferCount: 0n,
    },
    ProcessMemoryLimit: 0,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  };
}

export class KoffiJobObjectPort implements JobObjectPort {
  createKillOnCloseJob(): unknown | null {
    const job = CreateJobObjectW(null, null);
    if (!job) return null;

    const applied = SetInformationJobObject(
      job,
      JOBOBJECTINFOCLASS_EXTENDED_LIMIT_INFORMATION,
      killOnCloseLimits(),
      koffi.sizeof(ExtendedLimitInformationType)
    );
    if (!applied) {
      CloseHandleFn(job);
      return null;
    }

    return job;
  }

  assign(job: unknown, pid: number): boolean {
    const process = OpenProcessForContainment(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
    if (!process) return false;

    try {
      return AssignProcessToJobObjectFn(job, process) !== 0;
    } finally {
      CloseHandleFn(process);
    }
  }

  terminate(job: unknown): void {
    TerminateJobObjectFn(job, 1);
    CloseHandleFn(job);
  }
}
