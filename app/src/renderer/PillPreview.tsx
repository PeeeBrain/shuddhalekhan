import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { publishAudioLevel, setBandReader } from './audio-level';
import { demoBands, demoLevel } from './recording-popup-math';
import { ProcessingPill, RecordingPopup, ThinkingField } from './RecordingPopup';

/**
 * Dev only: the production pills in every state on a synthetic voice, so they
 * can be reviewed and captured in a normal window without a microphone or
 * hotkey. Open `#pill-preview` on the dev renderer URL, in Electron or a browser.
 */
export function PillPreview() {
  const [startedAt] = useState(Date.now);
  useEffect(() => {
    const start = performance.now();
    // About the rate the capture window publishes real levels.
    const id = setInterval(() => publishAudioLevel(demoLevel(performance.now() - start)), 66);
    setBandReader((out) => {
      demoBands(performance.now() - start, out);
      return true;
    });
    return () => {
      clearInterval(id);
      setBandReader(null);
      publishAudioLevel(0);
    };
  }, []);

  return (
    <main className="grid min-h-screen place-content-center gap-x-10 gap-y-6 bg-background p-10 text-foreground sm:grid-cols-2">
      <Cell label="Dictation · preparing">
        <RecordingPopup intent="dictation" captureStartedAt={null} />
      </Cell>
      <Cell label="Dictation · time limit">
        <RecordingPopup intent="dictation" captureStartedAt={startedAt} remainingSeconds={10} />
      </Cell>
      <Cell label="Dictation · recording">
        <RecordingPopup intent="dictation" captureStartedAt={startedAt} />
      </Cell>
      <Cell label="Agent · recording">
        <RecordingPopup intent="agent" captureStartedAt={startedAt} />
      </Cell>
      <Cell label="Dictation · transcribing">
        <ProcessingPill intent="dictation" />
      </Cell>
      <Cell label="Agent · transcribing">
        <ProcessingPill intent="agent" />
      </Cell>
      <figure className="m-0 flex flex-col items-center gap-2 sm:col-span-2">
        {/* The Agent card's body text, where the thinking status renders. */}
        <div className="agent-island w-[360px] border px-4 py-3 text-sm leading-relaxed">
          <ThinkingField />
        </div>
        <figcaption className="text-xs text-muted-foreground">Agent · thinking</figcaption>
      </figure>
    </main>
  );
}

/** The runtime shell's recording-sized slot, so each pill sits exactly as it does on screen. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="m-0 flex flex-col items-center gap-2">
      <div className="flex h-[52px] w-[172px] items-center justify-center">{children}</div>
      <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  );
}
