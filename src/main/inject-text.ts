import { clipboard } from 'electron';
import { simulatePaste } from './native/clipboard';

export type TextInjectionResult =
  | { status: 'injected' }
  | { status: 'paste-blocked'; message: string };

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

export async function injectIntoFocusedApp(
  text: string,
  deps: InjectTextDeps = defaultDeps
): Promise<TextInjectionResult> {
  const originalClipboard = deps.readText();

  deps.writeText(text);
  await deps.delay(50);

  try {
    deps.simulatePaste();
    await deps.delay(100);
  } catch (error) {
    if (originalClipboard) {
      deps.writeText(originalClipboard);
    }
    return {
      status: 'paste-blocked',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (originalClipboard) {
    deps.writeText(originalClipboard);
  }

  return { status: 'injected' };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
