declare module 'bun:test' {
  export const beforeEach: any;
  export const afterEach: any;
  export const afterAll: any;
  export const describe: any;
  export const expect: any;
  export const it: any;
  export const mock: any;
  export const spyOn: any;
}

declare const Bun: {
  file(path: string): { text(): Promise<string> };
};

interface ImportMeta {
  dir: string;
}
