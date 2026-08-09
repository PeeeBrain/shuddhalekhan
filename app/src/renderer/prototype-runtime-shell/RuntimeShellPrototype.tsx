// PROTOTYPE ONLY — three runtime-shell visual systems, switchable via ?variant=.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleEllipsis,
  Command,
  FileText,
  Mail,
  Mic,
  MousePointer2,
  Radio,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Volume2,
  X,
  XCircle,
} from 'lucide-react';

const variants = {
  A: { name: 'Morphing capsule', component: VariantA },
  B: { name: 'Command rail', component: VariantB },
  C: { name: 'Quiet stack', component: VariantC },
} as const;

type VariantKey = keyof typeof variants;
type SurfaceKey =
  | 'dictation'
  | 'agent-recording'
  | 'processing'
  | 'status'
  | 'streaming'
  | 'approval'
  | 'completed'
  | 'failure';

type SurfaceDefinition = {
  label: string;
  shortLabel: string;
  family: 'recording' | 'passive' | 'interactive';
  anchor: 'center' | 'right';
  announcement: string;
};

const surfaces: Record<SurfaceKey, SurfaceDefinition> = {
  dictation: {
    label: 'Dictation recording',
    shortLabel: 'Dictation',
    family: 'recording',
    anchor: 'center',
    announcement: 'Dictation recording in progress, 12 seconds elapsed.',
  },
  'agent-recording': {
    label: 'Agent recording',
    shortLabel: 'Agent record',
    family: 'recording',
    anchor: 'center',
    announcement: 'Agent command recording in progress, 12 seconds elapsed.',
  },
  processing: {
    label: 'Post-capture processing',
    shortLabel: 'Processing',
    family: 'passive',
    anchor: 'center',
    announcement: 'Finalizing dictation.',
  },
  status: {
    label: 'Agent tool status',
    shortLabel: 'Status',
    family: 'passive',
    anchor: 'right',
    announcement: 'Agent is checking recent messages.',
  },
  streaming: {
    label: 'Agent response streaming',
    shortLabel: 'Streaming',
    family: 'passive',
    anchor: 'right',
    announcement: 'Agent response is streaming. Tokens are not announced individually.',
  },
  approval: {
    label: 'Tool approval',
    shortLabel: 'Approval',
    family: 'interactive',
    anchor: 'right',
    announcement: 'Approval required for Gmail send message. 18 seconds remain.',
  },
  completed: {
    label: 'Completed result',
    shortLabel: 'Complete',
    family: 'interactive',
    anchor: 'right',
    announcement: 'Agent completed. Draft prepared and calendar checked.',
  },
  failure: {
    label: 'Persistent failure',
    shortLabel: 'Failure',
    family: 'interactive',
    anchor: 'right',
    announcement: 'Dictation could not be inserted. Text is available to copy.',
  },
};

const surfaceOrder = Object.keys(surfaces) as SurfaceKey[];

type PrototypeFlags = {
  overflow: boolean;
  reducedMotion: boolean;
  active: boolean;
};

type VariantProps = PrototypeFlags & {
  surface: SurfaceKey;
  onActivate: () => void;
};

export function RuntimeShellPrototype() {
  const [variant, setVariant] = useState<VariantKey>(() => readVariant());
  const [surface, setSurface] = useState<SurfaceKey>('dictation');
  const [overflow, setOverflow] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [dpi, setDpi] = useState(100);
  const [workArea, setWorkArea] = useState<'wide' | 'compact'>('wide');
  const [activeKey, setActiveKey] = useState('');
  const [scenario, setScenario] = useState<string>('Manual inspection');
  const scenarioRun = useRef(0);

  const selectVariant = useCallback((next: VariantKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set('variant', next);
    window.history.replaceState({}, '', url);
    setVariant(next);
  }, []);

  const cycleVariant = useCallback((direction: -1 | 1) => {
    const keys = Object.keys(variants) as VariantKey[];
    const nextIndex = (keys.indexOf(variant) + direction + keys.length) % keys.length;
    selectVariant(keys[nextIndex]);
  }, [selectVariant, variant]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') cycleVariant(-1);
      if (event.key === 'ArrowRight') cycleVariant(1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cycleVariant]);

  const runScenario = useCallback(async (
    name: string,
    steps: Array<{ state: SurfaceKey; wait: number }>,
  ) => {
    const run = ++scenarioRun.current;
    setScenario(name);
    for (const step of steps) {
      if (run !== scenarioRun.current) return;
      setSurface(step.state);
      await new Promise((resolve) => window.setTimeout(resolve, step.wait));
    }
    if (run === scenarioRun.current) setScenario(`${name} · settled`);
  }, []);

  const Variant = variants[variant].component;
  const definition = surfaces[surface];
  const active = activeKey === `${variant}:${surface}`;

  return (
    <main className={`prototype-root ${reducedMotion ? 'reduce-motion' : ''}`}>
      <header className="prototype-header">
        <div>
          <p className="eyebrow">WAYFINDER PROTOTYPE · THROWAWAY</p>
          <h1>One shell, many moments</h1>
          <p className="header-copy">
            Compare three visual contracts for Shuddhalekhan’s persistent runtime shell.
          </p>
        </div>
        <div className="header-meta" aria-label="Prototype constraints">
          <span><Square size={13} /> one native window</span>
          <span><MousePointer2 size={13} /> passive by default</span>
          <span><Volume2 size={13} /> semantic live regions</span>
        </div>
      </header>

      <section className="prototype-workbench">
        <aside className="control-deck" aria-label="Prototype controls">
          <ControlSection title="Surface family" annotation="Priority order">
            <div className="surface-list">
              {surfaceOrder.map((key, index) => (
                <button
                  type="button"
                  key={key}
                  className={surface === key ? 'surface-button selected' : 'surface-button'}
                  onClick={() => {
                    scenarioRun.current += 1;
                    setScenario('Manual inspection');
                    setSurface(key);
                  }}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  {surfaces[key].label}
                </button>
              ))}
            </div>
          </ControlSection>

          <ControlSection title="Transition trials" annotation={scenario}>
            <div className="scenario-grid">
              <button type="button" onClick={() => void runScenario('Dictation preempts Agent', [
                { state: 'streaming', wait: 900 },
                { state: 'dictation', wait: 1200 },
                { state: 'processing', wait: 900 },
                { state: 'completed', wait: 0 },
              ])}>Agent → Dictation</button>
              <button type="button" onClick={() => void runScenario('Approval survives recording', [
                { state: 'approval', wait: 1000 },
                { state: 'dictation', wait: 1200 },
                { state: 'approval', wait: 0 },
              ])}>Approval → Record</button>
              <button type="button" onClick={() => void runScenario('New Agent replaces old run', [
                { state: 'streaming', wait: 900 },
                { state: 'agent-recording', wait: 1200 },
                { state: 'processing', wait: 900 },
                { state: 'status', wait: 0 },
              ])}>Replace Agent</button>
            </div>
          </ControlSection>

          <ControlSection title="Stress the contract" annotation={`${dpi}% DPI`}>
            <label className="toggle-row">
              <span>Long content</span>
              <input type="checkbox" checked={overflow} onChange={(event) => setOverflow(event.target.checked)} />
            </label>
            <label className="toggle-row">
              <span>Reduced motion</span>
              <input type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} />
            </label>
            <div className="segmented" aria-label="DPI scale">
              {[100, 125, 150].map((value) => (
                <button type="button" className={dpi === value ? 'selected' : ''} key={value} onClick={() => setDpi(value)}>{value}%</button>
              ))}
            </div>
            <div className="segmented" aria-label="Simulated work area">
              <button type="button" className={workArea === 'wide' ? 'selected' : ''} onClick={() => setWorkArea('wide')}>Wide</button>
              <button type="button" className={workArea === 'compact' ? 'selected' : ''} onClick={() => setWorkArea('compact')}>Compact</button>
            </div>
          </ControlSection>
        </aside>

        <section className={`desktop-stage ${workArea}`} aria-label="Simulated Windows work area">
          <div className="desktop-wallpaper" aria-hidden="true" />
          <div className="desktop-app" aria-hidden="true">
            <div className="fake-titlebar"><span /><span>Quarterly review — Notes</span><i>— □ ×</i></div>
            <div className="fake-document">
              <span className="document-kicker">MEETING NOTES</span>
              <h2>Product launch review</h2>
              <p>The launch is on track for the second week of September.</p>
              <p className="cursor-line">Follow up with the design team about <b className="text-cursor" /></p>
            </div>
          </div>

          <div className="work-area-label" aria-hidden="true">
            <span>{workArea === 'wide' ? '1440 × 900' : '1024 × 640'} work area</span>
            <span>{dpi}% simulated scale</span>
          </div>

          <div
            className={`runtime-window-anchor dpi-${dpi} ${definition.anchor} ${definition.family}`}
            style={{ '--prototype-dpi': dpi / 100 } as React.CSSProperties}
          >
            <div className="native-boundary-label" aria-hidden="true">
              <span>runtime-shell</span>
              <span>{definition.family === 'interactive' ? (active ? 'active' : 'shown inactive') : 'click-through'}</span>
            </div>
            <Variant
              surface={surface}
              overflow={overflow}
              reducedMotion={reducedMotion}
              active={active}
              onActivate={() => setActiveKey(`${variant}:${surface}`)}
            />
          </div>

          <div className="taskbar" aria-hidden="true">
            <Command size={14} />
            <span className="taskbar-search">Search</span>
            <FileText size={15} />
            <Mail size={15} />
            <span className="taskbar-time">11:42<br />08/09/2026</span>
          </div>
        </section>
      </section>

      <section className="semantic-strip" aria-label="Accessibility inspection">
        <div>
          <span className="semantic-label">ANNOUNCEMENT</span>
          <p>{definition.announcement}</p>
        </div>
        <div>
          <span className="semantic-label">NATIVE POLICY</span>
          <p>{definition.family === 'interactive' ? 'Shown inactive; activates only after a deliberate click.' : 'Non-focusable, click-through, shown without activation.'}</p>
        </div>
        <div>
          <span className="semantic-label">ANCHOR</span>
          <p>{definition.anchor === 'center' ? 'Latched display · bottom center' : 'Latched display · bottom right'}</p>
        </div>
      </section>

      <PrototypeSwitcher current={variant} onCycle={cycleVariant} />
    </main>
  );
}

function ControlSection({ title, annotation, children }: { title: string; annotation: string; children: React.ReactNode }) {
  return (
    <section className="control-section">
      <div className="control-heading"><h2>{title}</h2><span>{annotation}</span></div>
      {children}
    </section>
  );
}

export function VariantA(props: VariantProps) {
  const { surface, active, onActivate } = props;
  if (surface === 'dictation' || surface === 'agent-recording') {
    const isAgent = surface === 'agent-recording';
    return (
      <ShellFrame variant="a" {...props}>
        <div className={`a-capsule ${isAgent ? 'agent' : 'dictation'}`} role="status" aria-live="polite">
          <div className="mode-disc">{isAgent ? <Bot size={16} /> : <Mic size={16} />}</div>
          <Waveform />
          <span className="timecode">00:12</span>
          <span className="intent-label">{isAgent ? 'Agent' : 'Dictation'}</span>
        </div>
      </ShellFrame>
    );
  }

  if (surface === 'processing') {
    return (
      <ShellFrame variant="a" {...props}>
        <div className="a-processing" role="status" aria-live="polite">
          <Spinner />
          <span>Finalizing dictation</span>
          <i />
        </div>
      </ShellFrame>
    );
  }

  return (
    <ShellFrame variant="a" {...props}>
      <article className={`a-card tone-${toneFor(surface)}`} {...liveRegionFor(surface)}>
        <header className="a-card-header">
          <div className="a-heading-mark">{iconFor(surface)}</div>
          <div><span className="micro-label">{surfaces[surface].shortLabel}</span><h3>{titleFor(surface)}</h3></div>
          {surface === 'approval' ? <span className="countdown">00:18</span> : null}
          {surface === 'completed' || surface === 'failure' ? <button type="button" className="icon-button" aria-label="Dismiss"><X size={14} /></button> : null}
        </header>
        <ShellBody surface={surface} overflow={props.overflow} active={active} layout="flow" />
        <ShellActions surface={surface} active={active} layout="flow" />
      </article>
      <ActivationGate surface={surface} active={active} onActivate={onActivate} />
    </ShellFrame>
  );
}

export function VariantB(props: VariantProps) {
  const { surface, active, onActivate } = props;
  return (
    <ShellFrame variant="b" {...props}>
      <article className={`b-shell tone-${toneFor(surface)}`} {...liveRegionFor(surface)}>
        <div className="b-rail" aria-hidden="true">
          <span className="b-brand">शु</span>
          <span className="b-rail-icon">{iconFor(surface)}</span>
          <i />
          <span className="b-step">{String(surfaceOrder.indexOf(surface) + 1).padStart(2, '0')}</span>
        </div>
        <div className="b-content">
          <header className="b-header">
            <div><span className="micro-label">{surfaces[surface].shortLabel}</span><h3>{titleFor(surface)}</h3></div>
            {surface === 'approval' ? <span className="countdown">18 sec</span> : <span className="b-status-dot" />}
          </header>
          {(surface === 'dictation' || surface === 'agent-recording') ? (
            <div className="b-recording" role="status" aria-live="polite">
              <Waveform />
              <div><strong>00:12</strong><span>{surface === 'dictation' ? 'Listening to Dictation' : 'Listening for Agent command'}</span></div>
            </div>
          ) : surface === 'processing' ? (
            <div className="b-process-line" role="status" aria-live="polite"><span /><p>Audio captured. Finalizing stable text…</p></div>
          ) : (
            <>
              <ShellBody surface={surface} overflow={props.overflow} active={active} layout="rail" />
              <ShellActions surface={surface} active={active} layout="rail" />
            </>
          )}
        </div>
      </article>
      <ActivationGate surface={surface} active={active} onActivate={onActivate} />
    </ShellFrame>
  );
}

export function VariantC(props: VariantProps) {
  const { surface, active, onActivate } = props;
  const recording = surface === 'dictation' || surface === 'agent-recording';
  return (
    <ShellFrame variant="c" {...props}>
      <article className={`c-shell tone-${toneFor(surface)} ${recording ? 'recording' : ''}`} {...liveRegionFor(surface)}>
        <div className="c-orbit" aria-hidden="true"><span>{iconFor(surface)}</span><i /></div>
        <div className="c-card">
          <header className="c-header">
            <span className="micro-label">{surfaces[surface].shortLabel}</span>
            {surface === 'approval' ? <span className="countdown">18s</span> : null}
          </header>
          {recording ? (
            <div className="c-recording" role="status" aria-live="polite">
              <strong>{surface === 'dictation' ? 'Speak naturally' : 'What should I do?'}</strong>
              <div><Waveform /><span className="timecode">00:12</span></div>
            </div>
          ) : surface === 'processing' ? (
            <div className="c-processing" role="status" aria-live="polite"><strong>One moment</strong><span>Finalizing dictation</span><ProgressLine /></div>
          ) : (
            <>
              <h3>{titleFor(surface)}</h3>
              <ShellBody surface={surface} overflow={props.overflow} active={active} layout="stack" />
              <ShellActions surface={surface} active={active} layout="stack" />
            </>
          )}
        </div>
      </article>
      <ActivationGate surface={surface} active={active} onActivate={onActivate} />
    </ShellFrame>
  );
}

function ShellFrame({ variant, surface, reducedMotion, children }: VariantProps & { variant: 'a' | 'b' | 'c'; children: React.ReactNode }) {
  return (
    <div className={`shell-frame variant-${variant} surface-${surface} ${reducedMotion ? 'no-motion' : ''}`}>
      {children}
    </div>
  );
}

function ShellBody({ surface, overflow, active, layout }: { surface: SurfaceKey; overflow: boolean; active: boolean; layout: 'flow' | 'rail' | 'stack' }) {
  if (surface === 'status') {
    return <div className={`shell-copy status-copy ${layout}`}><p>Checking your recent messages</p><span>Gmail · read only</span></div>;
  }
  if (surface === 'streaming') {
    return (
      <div className={`shell-copy response-copy ${layout}`}>
        <p>I found three messages that need attention. The design review moved to <strong>Thursday at 2:30 PM</strong>.</p>
        {overflow ? <><p>Two launch-checklist items are still open: confirm the localization handoff and approve the final store screenshots.</p><p>I can prepare a concise reply to the design team when you’re ready.</p></> : null}
        <span className="stream-caret" aria-hidden="true" />
      </div>
    );
  }
  if (surface === 'approval') {
    return (
      <div className={`shell-copy approval-copy ${layout}`}>
        <p className="tool-path"><span>Gmail</span><ChevronRight size={12} /><strong>send_message</strong></p>
        <div className="argument-preview"><span>To</span><strong>design@acme.test</strong><span>Subject</span><strong>Thursday review</strong>{overflow ? <><span>Body</span><strong>Confirming the review has moved to Thursday at 2:30 PM. I’ll bring the updated launch checklist and localization notes.</strong></> : null}</div>
        <label className="feedback-field"><span>Feedback if denied</span><textarea rows={1} disabled={!active} placeholder="Optional correction…" aria-label="Optional denial feedback" /></label>
      </div>
    );
  }
  if (surface === 'completed') {
    return (
      <div className={`shell-copy response-copy ${layout}`}>
        <p>Your reply is ready as a draft, and the Thursday review does not conflict with your calendar.</p>
        {overflow ? <p>I also kept the original recipient list unchanged and did not send anything without approval.</p> : null}
        <div className="result-chips"><span><Mail size={11} /> Draft prepared</span><span><Check size={11} /> Calendar checked</span></div>
      </div>
    );
  }
  if (surface === 'failure') {
    return (
      <div className={`shell-copy failure-copy ${layout}`}>
        <p>Dictation could not be inserted because the original window is no longer available.</p>
        {overflow ? <p>Your committed text is preserved locally for explicit recovery. Shuddhalekhan will not retarget another window.</p> : <span>Committed text is safe to copy.</span>}
      </div>
    );
  }
  return null;
}

function ShellActions({ surface, active, layout }: { surface: SurfaceKey; active: boolean; layout: 'flow' | 'rail' | 'stack' }) {
  if (surface === 'approval') {
    return <div className={`shell-actions ${layout}`}><button type="button" disabled={!active} className="secondary-action"><XCircle size={14} /> Deny</button><button type="button" disabled={!active} className="primary-action"><ShieldCheck size={14} /> Approve</button></div>;
  }
  if (surface === 'completed') {
    return <div className={`shell-actions ${layout}`}><button type="button" disabled={!active} className="secondary-action"><X size={14} /> Dismiss</button></div>;
  }
  if (surface === 'failure') {
    return <div className={`shell-actions ${layout}`}><button type="button" disabled={!active} className="secondary-action"><Settings2 size={14} /> Settings</button><button type="button" disabled={!active} className="primary-action"><FileText size={14} /> Copy text</button></div>;
  }
  return null;
}

function ActivationGate({ surface, active, onActivate }: { surface: SurfaceKey; active: boolean; onActivate: () => void }) {
  if (surfaces[surface].family !== 'interactive' || active) return null;
  return <button type="button" className="activation-gate" onClick={onActivate}><MousePointer2 size={14} /><span>Click to activate controls</span></button>;
}

function PrototypeSwitcher({ current, onCycle }: { current: VariantKey; onCycle: (direction: -1 | 1) => void }) {
  return (
    <nav className="prototype-switcher" aria-label="Prototype variants">
      <button type="button" onClick={() => onCycle(-1)} aria-label="Previous variant"><ArrowLeft size={15} /></button>
      <div><span>VARIANT {current}</span><strong>{variants[current].name}</strong></div>
      <button type="button" onClick={() => onCycle(1)} aria-label="Next variant"><ArrowRight size={15} /></button>
    </nav>
  );
}

function Waveform() {
  return <span className="waveform" aria-hidden="true">{[3, 8, 13, 6, 17, 10, 5, 14, 8, 4].map((height, index) => <i key={index} style={{ height }} />)}</span>;
}

function Spinner() {
  return <CircleEllipsis className="spinner" size={17} aria-hidden="true" />;
}

function ProgressLine() {
  return <span className="progress-line" aria-hidden="true"><i /></span>;
}

function toneFor(surface: SurfaceKey): 'blue' | 'red' | 'amber' | 'green' | 'danger' {
  if (surface === 'agent-recording') return 'red';
  if (surface === 'approval') return 'amber';
  if (surface === 'completed') return 'green';
  if (surface === 'failure') return 'danger';
  return 'blue';
}

function titleFor(surface: SurfaceKey): string {
  switch (surface) {
    case 'status': return 'Checking recent messages';
    case 'streaming': return 'Here’s what I found';
    case 'approval': return 'Send this message?';
    case 'completed': return 'Command complete';
    case 'failure': return 'Insertion stopped safely';
    default: return surfaces[surface].label;
  }
}

function iconFor(surface: SurfaceKey) {
  switch (surface) {
    case 'dictation': return <Mic size={16} />;
    case 'agent-recording': return <Bot size={16} />;
    case 'processing': return <RotateCcw size={16} />;
    case 'status': return <Radio size={16} />;
    case 'streaming': return <Sparkles size={16} />;
    case 'approval': return <ShieldCheck size={16} />;
    case 'completed': return <CheckCircle2 size={16} />;
    case 'failure': return <AlertTriangle size={16} />;
  }
}

function liveRegionFor(surface: SurfaceKey): { role?: 'alert' | 'status'; 'aria-live'?: 'polite' } {
  if (surface === 'approval' || surface === 'failure') return { role: 'alert' };
  return { role: 'status', 'aria-live': 'polite' };
}

function readVariant(): VariantKey {
  const value = new URLSearchParams(window.location.search).get('variant')?.toUpperCase();
  return value === 'B' || value === 'C' ? value : 'A';
}
