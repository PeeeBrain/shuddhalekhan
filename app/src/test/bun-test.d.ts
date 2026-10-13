declare module 'bun:test' {
  export const beforeEach: any;
  export const beforeAll: any;
  export const afterEach: any;
  export const afterAll: any;
  export const describe: any;
  export const expect: any;
  export const it: any;
  export const mock: any;
  export const spyOn: any;
}

declare const Bun: {
  spawn(args: string[], options: { stdout: 'pipe'; stderr: 'pipe' }): {
    exited: Promise<number>;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
  };
  file(path: string): { text(): Promise<string> };
};

interface ImportMeta {
  dir: string;
}
