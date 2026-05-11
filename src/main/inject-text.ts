import { clipboard } from 'electron';
import { simulatePaste } from './native/clipboard';

interface InjectTextDeps {
  readText: () => string;
  writeText: (text: string) => void;
  simulatePaste: () => void;
  delay: (ms: number) => Promise<void>;
}

const defaultDeps: InjectTextDeps = {
  readText: () => clipboard.readText(),
  writeText: (text) => clipboard.writeText(text),
  simulatePaste,
  delay,
};

export async function injectIntoFocusedApp(text: string, deps: InjectTextDeps = defaultDeps): Promise<void> {
  const originalClipboard = deps.readText();

  deps.writeText(text);
  await deps.delay(50);

  deps.simulatePaste();
  await deps.delay(100);

  if (originalClipboard) {
    deps.writeText(originalClipboard);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
