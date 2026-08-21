import { beforeEach, describe, expect, it, mock } from 'bun:test';

const kernel32Functions = new Map<string, ReturnType<typeof mock>>();
const structSizes = new Map<string, number>();
let openProcessResult: unknown = { id: 'proc-handle' };

mock.module('koffi', () => ({
  default: {
    load: mock((library: string) => ({
      func: mock((signature: string) => {
        const fn = mock((..._args: unknown[]) => {
          if (signature.includes('CreateJobObjectW')) return { id: 'job-handle' };
          if (signature.includes('SetInformationJobObject')) return 1;
          if (signature.includes('AssignProcessToJobObject')) return 1;
          if (signature.includes('OpenProcess')) return openProcessResult;
          if (signature.includes('TerminateJobObject')) return 1;
          if (signature.includes('CloseHandle')) return 1;
          return 0;
        });
        if (library === 'kernel32.dll') kernel32Functions.set(signature, fn);
        return fn;
      }),
    })),
    struct: mock((_name: string, shape: unknown) => shape),
    sizeof: mock((type: { _name?: string }) => structSizes.get(String(type)) ?? 144),
    pointer: mock((value: unknown) => value),
  },
}));

type JobObjectModule = typeof import('../native/job-object');

async function importJobObjectModule(testName: string): Promise<JobObjectModule> {
  return import(`../native/job-object?test=${Date.now()}-${testName}`);
}

function findFunction(fragment: string): ReturnType<typeof mock> {
  const match = Array.from(kernel32Functions.entries()).find(([signature]) => signature.includes(fragment));
  if (!match) throw new Error(`kernel32 function not registered: ${fragment}`);
  return match[1];
}

describe('KoffiJobObjectPort', () => {
  beforeEach(() => {
    kernel32Functions.clear();
    openProcessResult = { id: 'proc-handle' };
  });

  it('creates a kill-on-close job without breakaway allowances', async () => {
    const { KoffiJobObjectPort } = await importJobObjectModule('create');
    const port = new KoffiJobObjectPort();

    const handle = port.createKillOnCloseJob();

    expect(handle).toEqual({ id: 'job-handle' });
    expect(findFunction('CreateJobObjectW').mock.calls[0]).toEqual([null, null]);

    const setCall = findFunction('SetInformationJobObject').mock.calls[0] as unknown[];
    const setSignature = [...kernel32Functions.keys()].find((signature) =>
      signature.includes('SetInformationJobObject')
    );
    expect(setSignature).toContain('JOBOBJECT_EXTENDED_LIMIT_INFORMATION *');
    expect(setCall[0]).toEqual({ id: 'job-handle' });
    expect(setCall[1]).toBe(9);
    const limits = setCall[2] as { BasicLimitInformation: { LimitFlags: number } };
    expect(limits.BasicLimitInformation.LimitFlags).toBe(0x2000);
    expect(limits.BasicLimitInformation.LimitFlags & 0x800).toBe(0);
    expect(limits.BasicLimitInformation.LimitFlags & 0x1000).toBe(0);
    expect(setCall[3]).toBeGreaterThan(0);
  });

  it('assigns a process by pid with terminate access', async () => {
    const { KoffiJobObjectPort } = await importJobObjectModule('assign');
    const port = new KoffiJobObjectPort();
    const handle = port.createKillOnCloseJob();

    const assigned = port.assign(handle!, 4242);

    expect(assigned).toBe(true);
    expect(findFunction('OpenProcess').mock.calls[0]).toEqual([0x0101, 0, 4242]);
    expect(findFunction('AssignProcessToJobObject').mock.calls[0]).toEqual([
      { id: 'job-handle' },
      { id: 'proc-handle' },
    ]);
  });

  it('fails closed when the process handle cannot be opened', async () => {
    const { KoffiJobObjectPort } = await importJobObjectModule('assign-fail');
    const port = new KoffiJobObjectPort();
    const handle = port.createKillOnCloseJob();
    openProcessResult = null;

    const assigned = port.assign(handle!, 4242);

    expect(assigned).toBe(false);
    expect(findFunction('AssignProcessToJobObject').mock.calls).toHaveLength(0);
  });

  it('terminates the job and releases both handles', async () => {
    const { KoffiJobObjectPort } = await importJobObjectModule('terminate');
    const port = new KoffiJobObjectPort();
    const handle = port.createKillOnCloseJob();

    port.terminate(handle!);

    expect(findFunction('TerminateJobObject').mock.calls[0]).toEqual([{ id: 'job-handle' }, 1]);
    const closeCalls = findFunction('CloseHandle').mock.calls.map((call: unknown[]) => call[0]);
    expect(closeCalls).toContainEqual({ id: 'job-handle' });
  });
});
