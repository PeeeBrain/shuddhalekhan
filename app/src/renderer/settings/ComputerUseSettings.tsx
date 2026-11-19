import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { BookOpenIcon, DownloadIcon, ScanEyeIcon, ShieldCheckIcon, ToggleRightIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { AlertDialog, Popover, Portal } from 'radix-ui';
import {
  COMPUTER_USE_HEADED_ON_WINDOWS,
  COMPUTER_USE_TOOLS,
  computerUseToolPolicy,
  DEFAULT_COMPUTER_USE_CONFIG,
  type ComputerUseConfig,
  type ComputerUseStatus,
  type ComputerUseToolGroup,
} from '../../shared/computer-use';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { SectionHeader, SettingsCard, SettingsPanel, SettingsPanelHeader } from './ui/SectionHeader';
import { Tag, ToggleRow, ToolPolicySelect } from './ui/rows';
import { ipcErrorMessage } from './use-settings-persistence';
import type { SettingsSectionProps } from './settings-section-props';

const FIELD_ID_ENABLED = 'computer-use-enabled';
const FIELD_ID_POLICIES = 'computer-use-policies';
const FIELD_ID_TOUR = 'computer-use-tour';
const YOLO_TOOLS = COMPUTER_USE_TOOLS.filter(tool => tool.group !== 'clipboard');

/** The guide walks the real controls in page order; each step's bubble floats beside the control it explains. */
const TOUR_STEPS = ['about', 'install', 'enable', 'tools'] as const;
type TourStep = typeof TOUR_STEPS[number];
// Placement keeps the bubble off the control a step asks for: Install and the switch sit at the right edge.
const TOUR_PLACEMENT = {
  about: { side: 'bottom', align: 'start', Icon: ScanEyeIcon },
  install: { side: 'bottom', align: 'start', Icon: DownloadIcon },
  enable: { side: 'bottom', align: 'start', Icon: ToggleRightIcon },
  tools: { side: 'top', align: 'start', Icon: ShieldCheckIcon },
} as const;

const WINDOWS = navigator.userAgent.includes('Windows');
const AVAILABLE_YOLO_TOOLS = YOLO_TOOLS.filter(tool => !(WINDOWS && COMPUTER_USE_HEADED_ON_WINDOWS.has(tool.name)));
const GROUPS: Array<{ id: ComputerUseToolGroup; title: string; description: string }> = [
  { id: 'observe', title: 'Read', description: 'List apps and windows, and read what a window shows.' },
  { id: 'act', title: 'Act', description: 'Change a window: click, fill fields, choose options.' },
  { id: 'apps', title: 'Apps', description: WINDOWS
    ? 'Start any program by its full path, or by name from the Windows folder, and quit apps. Programs it starts, other than Store apps, close when Agent Mode stops or Shuddhalekhan quits. Always allow lets the agent run any of them without asking.'
    : 'Start any program on your PATH by name, not only apps, and quit apps (X11 apps only). Always allow lets the agent run any of them without asking.' },
  { id: 'clipboard', title: 'Clipboard', description: `Off until you turn it on. The clipboard can hold passwords.${WINDOWS ? '' : ' Wayland needs wl-clipboard.'}` },
];
const HELPER_NOTE = WINDOWS
  ? 'Windows security may block Computer Use when Smart App Control is on.'
  : 'Some Linux apps may not support Computer Use.';

export function ComputerUseSettings({ config, persistence, settingsIpc, onNavigate }: SettingsSectionProps) {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmYolo, setConfirmYolo] = useState(false);
  const yoloAction = useRef<HTMLButtonElement>(null);
  const [tourStep, setTourStep] = useState<TourStep | null>(null);
  // The real control the current step points at; the bubble and spotlight follow it.
  const [tourTarget, setTourTarget] = useState<HTMLElement | null>(null);
  const enabledErrorId = useId();
  const yoloErrorId = useId();
  // Set when the guide closes, so focus lands on Show guide.
  const focusNext = useRef(false);
  const tourOffered = useRef(false);

  useEffect(() => {
    let active = true;
    // A pushed status is always newer than the initial read, so the read never overwrites it.
    let pushed = false;
    const off = settingsIpc.onComputerUseStatusChanged((next) => {
      pushed = true;
      setStatus(next);
    });
    settingsIpc.getComputerUseStatus()
      .then((next) => { if (active && !pushed) setStatus(next); })
      .catch((cause) => { if (active) setError(ipcErrorMessage(cause, 'Could not read Computer Use status.')); });
    return () => {
      active = false;
      off?.();
    };
  }, [settingsIpc]);

  const run = async (action: () => Promise<ComputerUseStatus | void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) setStatus(next);
    } catch (cause) {
      setError(ipcErrorMessage(cause, fallback));
    } finally {
      setBusy(false);
    }
  };

  const computerUse = config.agent.computerUse ?? DEFAULT_COMPUTER_USE_CONFIG;
  const installed = status?.state === 'installed';
  const save = (next: ComputerUseConfig, fieldId: string) => {
    void persistence.commit('agent', { ...config.agent, computerUse: next }, fieldId);
  };
  const allowedYoloTools = AVAILABLE_YOLO_TOOLS.filter(tool => computerUseToolPolicy(computerUse, tool.name) === 'alwaysAllow');
  const yoloEnabled = allowedYoloTools.length === AVAILABLE_YOLO_TOOLS.length;
  const yoloCustom = allowedYoloTools.length > 0 && !yoloEnabled;
  const setYolo = (enabled: boolean) => {
    const toolPolicies = { ...computerUse.toolPolicies };
    for (const { name } of YOLO_TOOLS) toolPolicies[name] = enabled ? 'alwaysAllow' : 'alwaysAsk';
    save({ ...computerUse, toolPolicies }, FIELD_ID_POLICIES);
  };

  // Offered once to someone who has never set it up: no helper yet and no saved opt-in.
  // Existing installs keep `tourCompleted` undefined and are never interrupted.
  const firstRun = computerUse.tourCompleted === undefined && !computerUse.enabled
    && (status?.state === 'absent' || status?.state === 'failed');
  useEffect(() => {
    if (!firstRun || tourOffered.current) return;
    tourOffered.current = true;
    void persistence.commit('agent', { ...config.agent, computerUse: { ...computerUse, tourCompleted: false } }, FIELD_ID_TOUR);
  }, [firstRun, config.agent, computerUse, persistence]);

  const supported = status !== null && status.state !== 'unsupported';
  const touring = supported && computerUse.tourCompleted === false;
  // Until someone steps through it, the guide follows real progress, so a remount mid-download resumes on Install.
  const step = tourStep ?? (installed ? 'enable' : status?.state === 'installing' ? 'install' : 'about');
  const takeFocus = (element: HTMLElement | null) => {
    if (element && focusNext.current) {
      focusNext.current = false;
      element.focus();
    }
  };
  const endTour = () => {
    focusNext.current = true;
    save({ ...computerUse, tourCompleted: true }, FIELD_ID_TOUR);
  };
  const replayTour = () => {
    setTourStep('about');
    save({ ...computerUse, tourCompleted: false }, FIELD_ID_TOUR);
  };
  const targetOf = (at: TourStep) => (touring && step === at ? setTourTarget : undefined);
  const guide: Record<TourStep, { title: string; body: ReactNode; canContinue?: boolean }> = {
    about: {
      title: 'What Computer Use does',
      body: (
        <p>
          Read text, fill fields and click controls in your apps. No screenshots or mouse movements.
          What it reads goes to your Agent Mode model. Tools ask by default. Desktop access starts off.
        </p>
      ),
    },
    install: {
      title: 'Install the desktop helper',
      canContinue: installed,
      body: (
        <p>
          {installed
            ? 'Verified. It stays idle until you turn it on.'
            : status?.state === 'installing'
              ? 'Nothing runs until it is verified.'
              : status?.state === 'failed'
                ? 'Installation did not finish. Retry, or come back later.'
                : 'Next unlocks once it is installed.'}
        </p>
      ),
    },
    enable: {
      title: 'Turn it on when you are ready',
      body: !installed ? (
        <p>The switch unlocks once the helper is installed.</p>
      ) : !config.agent.enabled ? (
        <div className="space-y-2.5">
          <p>Computer Use runs inside Agent Mode, which is off.</p>
          <Button type="button" size="xs" variant="secondary" onClick={() => onNavigate('agent')}>Open Agent settings</Button>
        </div>
      ) : (
        <p>Your next Agent Mode command can then use the desktop.</p>
      ),
    },
    tools: {
      title: 'Choose what each tool may do',
      body: (
        <p>Always ask prompts you every time. Always allow runs without asking. Disabled hides the tool from the agent.</p>
      ),
    },
  };

  return (
    <div className="space-y-8">
      <div ref={targetOf('about')} className="scroll-mt-14">
        <SectionHeader
          title="Computer Use"
          description="Let Agent Mode read text, fill fields, and click controls in your desktop apps."
          actions={supported && !touring ? (
            <Button ref={takeFocus} variant="secondary" size="sm" className="cursor-pointer border border-border" onClick={replayTour}>
              <BookOpenIcon aria-hidden="true" />
              Show guide
            </Button>
          ) : null}
        />
      </div>

      {touring && tourTarget ? (
        <TourBubble
          step={step}
          target={tourTarget}
          title={guide[step].title}
          canContinue={guide[step].canContinue ?? true}
          onBack={() => setTourStep(TOUR_STEPS[TOUR_STEPS.indexOf(step) - 1])}
          onNext={step === 'tools' ? endTour : () => setTourStep(TOUR_STEPS[TOUR_STEPS.indexOf(step) + 1])}
          onExit={endTour}
        >
          {guide[step].body}
        </TourBubble>
      ) : null}

      <SettingsCard>
        <EngineRow
          ref={targetOf('install')}
          status={status}
          busy={busy}
          onInstall={() => void run(settingsIpc.installComputerUse, 'Could not install Computer Use.')}
          onCancel={() => void run(settingsIpc.cancelComputerUseInstall, 'Could not cancel the download.')}
          onRemove={() => void run(settingsIpc.uninstallComputerUse, 'Could not remove Computer Use.')}
        />
        {supported ? (
          <div ref={targetOf('enable')} className="scroll-mt-14">
            <ToggleRow
              title="Let the agent use your desktop"
              description={config.agent.enabled
                ? 'What the agent reads from a window is sent to your selected model. Each tool asks before it runs unless you change it below.'
                : 'Turn on Agent Mode first. What the agent reads from a window is sent to your selected model.'}
              checked={computerUse.enabled}
              // Turning it off never needs the helper or Agent Mode.
              disabled={busy || (!computerUse.enabled && (!installed || !config.agent.enabled))}
              tone="agent"
              errorId={enabledErrorId}
              error={persistence.fieldErrors[FIELD_ID_ENABLED]}
              onChange={(enabled) => save({ ...computerUse, enabled }, FIELD_ID_ENABLED)}
            />
          </div>
        ) : null}
      </SettingsCard>

      {error ? (
        <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive break-words">
          {error}
        </p>
      ) : null}

      {status?.state === 'unsupported' ? null : (
        <SettingsPanel aria-labelledby="computer-use-tools-heading">
          <SettingsPanelHeader
            id="computer-use-tools-heading"
            title="Tools"
            description="Choose what the agent can do and when it should ask you first."
          />
          <AlertDialog.Root open={confirmYolo} onOpenChange={setConfirmYolo}>
            <SettingsCard className="@container">
              <div className="flex flex-col items-start gap-4 py-4 @min-[40rem]:flex-row @min-[40rem]:items-center @min-[40rem]:justify-between @min-[40rem]:gap-6">
                <div className="min-w-0 space-y-1">
                  <h4 className="flex items-center gap-3 text-sm font-medium">
                    YOLO mode
                    <Tag tone={allowedYoloTools.length > 0 ? 'warning' : 'neutral'}>{yoloEnabled ? 'On' : yoloCustom ? 'Custom' : 'Off'}</Tag>
                  </h4>
                  <p className="max-w-md text-xs leading-5 text-muted-foreground">
                    {yoloCustom
                      ? `${allowedYoloTools.length} desktop tool${allowedYoloTools.length === 1 ? '' : 's'} can act without asking you first.`
                      : yoloEnabled ? 'Desktop tools can act without asking you first.' : 'Let desktop tools act without asking you first.'}
                  </p>
                  <p className="text-xs leading-5 text-muted-foreground">Clipboard permissions stay unchanged.</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {allowedYoloTools.length > 0 ? (
                    <Button ref={yoloEnabled ? yoloAction : undefined} variant="secondary" className="yolo-action border border-border" disabled={busy} onClick={() => {
                      setYolo(false);
                      if (yoloCustom) yoloAction.current?.focus();
                    }}>{yoloEnabled ? 'Turn off YOLO mode' : 'Restore approvals'}</Button>
                  ) : null}
                  {!yoloEnabled ? (
                    <AlertDialog.Trigger asChild>
                      <Button ref={yoloAction} variant="secondary" className="yolo-action border border-border" disabled={busy}>Enable YOLO mode</Button>
                    </AlertDialog.Trigger>
                  ) : null}
                </div>
              </div>
              {yoloCustom ? (
                <details className="pb-3 text-xs text-muted-foreground">
                  <summary className="w-fit cursor-pointer rounded py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">Review tools allowed without approval</summary>
                  <ul aria-label="Tools allowed without approval" className="mt-2 grid list-inside list-disc gap-1 sm:grid-cols-2">
                    {allowedYoloTools.map(tool => <li key={tool.name}>{tool.label}</li>)}
                  </ul>
                </details>
              ) : null}
              <p className="flex items-start gap-2 border-t border-border/50 py-3 text-xs leading-5 text-muted-foreground">
                <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span>Can run programs, change or delete data, and send information without approval.</span>
              </p>
              {persistence.fieldErrors[FIELD_ID_POLICIES] ? (
                <p id={yoloErrorId} role="alert" className="pb-3 text-xs text-destructive">{persistence.fieldErrors[FIELD_ID_POLICIES]}</p>
              ) : null}
            </SettingsCard>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className="fixed inset-0 z-[70] bg-black/60" />
              <AlertDialog.Content
                className="yolo-dialog-enter fixed top-1/2 left-1/2 z-[80] max-h-[calc(100dvh-3rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-2xl outline-none"
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  yoloAction.current?.focus();
                }}
              >
                <TriangleAlertIcon aria-hidden="true" className="mb-4 size-6 text-destructive" />
                <AlertDialog.Title className="text-lg font-semibold tracking-tight">Enable YOLO mode?</AlertDialog.Title>
                <AlertDialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">
                  The agent will be able to run programs, change or delete data, and send information without asking you first. Mistakes or malicious instructions can cause unwanted actions on your computer.
                </AlertDialog.Description>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">Clipboard permissions stay unchanged. You can turn YOLO mode off here at any time to restore approval prompts.</p>
                <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <AlertDialog.Cancel asChild>
                    <Button variant="secondary" className="yolo-action">Keep approvals</Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <Button variant="destructive" className="yolo-action" disabled={busy} onClick={() => setYolo(true)}>Enable YOLO mode</Button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>
          <SettingsCard>
            {GROUPS.map((group) => (
              <section key={group.id} aria-labelledby={`computer-use-group-${group.id}`} className="border-b border-border/50 py-3.5 last:border-b-0">
                <h4 id={`computer-use-group-${group.id}`} className="text-sm font-medium">{group.title}</h4>
                <p className="text-xs leading-5 text-muted-foreground">{group.description}</p>
                <div className="mt-2 divide-y divide-border/40">
                  {COMPUTER_USE_TOOLS.filter((tool) => tool.group === group.id && !(WINDOWS && COMPUTER_USE_HEADED_ON_WINDOWS.has(tool.name))).map((tool) => (
                    <div key={tool.name} ref={tool.name === 'desktop_snapshot' ? targetOf('tools') : undefined} className="grid scroll-mt-14 grid-cols-1 items-center gap-2 py-2 sm:grid-cols-[1fr_160px] sm:gap-3">
                      <p className="min-w-0 text-[13px]">
                        {tool.label}
                      </p>
                      <ToolPolicySelect
                        value={computerUseToolPolicy(computerUse, tool.name)}
                        label={tool.label}
                        disabled={busy}
                        onChange={(policy) => save({ ...computerUse, toolPolicies: { ...computerUse.toolPolicies, [tool.name]: policy } }, FIELD_ID_POLICIES)}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </SettingsCard>
        </SettingsPanel>
      )}
    </div>
  );
}

/**
 * A non-modal coachmark floating above Settings, anchored to the real control its step explains.
 * Nothing outside it is blocked or focus-trapped, so the target stays usable; Escape or the close button ends the guide.
 */
function TourBubble({ step, target, title, canContinue, onBack, onNext, onExit, children }: {
  step: TourStep;
  target: HTMLElement;
  title: string;
  canContinue: boolean;
  onBack: () => void;
  onNext: () => void;
  onExit: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  // Each step's panel is keyed, so it mounts per step and takes focus, the first one included.
  // A stable callback, unlike an effect, also catches the portal's delayed first mount.
  const panel = useCallback((element: HTMLDivElement | null) => element?.focus({ preventScroll: true }), []);
  const index = TOUR_STEPS.indexOf(step);
  const last = index === TOUR_STEPS.length - 1;
  const { side, align, Icon } = TOUR_PLACEMENT[step];

  return (
    <>
      <TourSpotlight step={step} target={target} />
      <Popover.Root open>
        <Popover.Anchor virtualRef={{ current: target }} />
        <Popover.Portal>
          <Popover.Content
            side={side}
            align={align}
            sideOffset={14}
            collisionPadding={{ top: 52, right: 16, bottom: 16, left: 16 }}
            aria-label="Computer Use guide"
            className="z-50 outline-none"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            onEscapeKeyDown={onExit}
          >
            <div
              key={step}
              ref={panel}
              role="group"
              tabIndex={-1}
              aria-labelledby={titleId}
              className="tour-step-enter max-h-(--radix-popover-content-available-height) w-[min(21rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-primary/35 bg-popover p-4 text-popover-foreground shadow-2xl shadow-black/50 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Popover.Arrow width={16} height={8} className="fill-primary" />
              <div className="flex items-start gap-3">
                <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                  <Icon className="size-4" />
                </span>
                <h3 id={titleId} className="min-w-0 flex-1 self-center text-sm font-semibold">{title}</h3>
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Skip guide" title="Skip guide (Esc)" className="-mt-1 -mr-1 text-muted-foreground" onClick={onExit}>
                  <XIcon />
                </Button>
              </div>
              <div className="mt-2.5 text-xs leading-5 text-muted-foreground">{children}</div>
              <div className="mt-4 flex items-center gap-2">
                <span className="flex gap-1">
                  {TOUR_STEPS.map((item, i) => (
                    <span key={item} aria-hidden="true" className={cn('h-1 rounded-full', i === index ? 'w-4 bg-primary' : i < index ? 'w-1.5 bg-primary/50' : 'w-1.5 bg-border')} />
                  ))}
                  <span className="sr-only">Step {index + 1} of {TOUR_STEPS.length}</span>
                </span>
                <span className="ml-auto flex gap-1.5">
                  {index > 0 ? <Button type="button" variant="ghost" size="sm" onClick={onBack}>Back</Button> : null}
                  <Button type="button" size="sm" disabled={!canContinue} onClick={onNext}>{last ? 'Done' : 'Next'}</Button>
                </span>
              </div>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

/** Dims Settings around the target and rings it. Pointer-transparent, so the backdrop never blocks a click. */
function TourSpotlight({ step, target }: { step: TourStep; target: HTMLElement }) {
  const box = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    // Written straight to the style so scrolling repositions the ring without re-rendering React.
    const place = () => {
      const style = box.current?.style;
      if (!style) return;
      const rect = target.getBoundingClientRect();
      style.transform = `translate(${rect.left - 6}px, ${rect.top - 6}px)`;
      style.width = `${rect.width + 12}px`;
      style.height = `${rect.height + 12}px`;
    };
    place();
    // Leave room below tall targets for the bubble, including at the minimum window size.
    target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    const observer = new ResizeObserver(place);
    observer.observe(target);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [target]);

  return (
    <Portal.Root>
      <div ref={box} aria-hidden="true" className="tour-spotlight pointer-events-none fixed top-0 left-0 z-40 rounded-xl">
        <div key={step} className="tour-ring-enter absolute inset-0 rounded-[inherit] ring-2 ring-primary/80" />
      </div>
    </Portal.Root>
  );
}

const formatMegabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

function EngineRow({ ref, status, busy, onInstall, onCancel, onRemove }: {
  ref?: Ref<HTMLDivElement>;
  status: ComputerUseStatus | null;
  busy: boolean;
  onInstall: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  return (
    <div ref={ref} className="flex scroll-mt-14 flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border/50 py-3.5 last:border-b-0">
      <div className="min-w-0 max-w-xl space-y-0.5">
        <p className="flex items-center gap-2 text-sm font-medium">
          Desktop helper
          {status?.state === 'installed' ? <Tag tone="success">Installed</Tag> : null}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          Install once to let Agent Mode work with your desktop apps. {HELPER_NOTE}
        </p>
        {status?.state === 'installing' ? (
          <div className="w-64 max-w-full space-y-1.5 pt-1">
            <Progress value={status.receivedBytes / Math.max(1, status.totalBytes) * 100} label="Desktop helper download" />
            <p className="text-xs" role="status">
              {status.receivedBytes < status.totalBytes
                ? `Downloading… ${Math.round(status.receivedBytes / Math.max(1, status.totalBytes) * 100)}% (${formatMegabytes(status.receivedBytes)} of ${formatMegabytes(status.totalBytes)})`
                : 'Verifying…'}
            </p>
          </div>
        ) : null}
        {status?.state === 'failed' ? <p className="text-xs text-destructive break-words" role="alert">{status.reason}</p> : null}
        {status?.state === 'unsupported' ? <p className="text-xs text-muted-foreground" role="status">{status.reason}</p> : null}
      </div>
      {status?.state === 'installed' ? (
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={onRemove}>Remove</Button>
      ) : status?.state === 'installing' ? (
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      ) : status?.state === 'absent' || status?.state === 'failed' ? (
        <Button size="sm" disabled={busy} onClick={onInstall}>{status.state === 'failed' ? 'Retry' : 'Install'}</Button>
      ) : null}
    </div>
  );
}
