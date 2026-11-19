#!/usr/bin/env bun
// Drives one Shuddhalekhan dev instance (Linux or Windows) over Chrome DevTools Protocol.
// Run from the repo root: bun .claude/skills/verify-shuddhalekhan/sl.ts <command>
//   launch                       start `bun run dev` on the maintainer's real config; wait until Settings is usable
//   doctor                       read-only health check of the instance this run started
//   open-settings                open the app again, as a user would, so the running instance shows Settings
//   targets                      list renderer pages (route is the part after #/)
//   eval <route> <js>            evaluate JS in the page whose URL ends with #/<route>; prints JSON
//   click <route> <text>         click the button/link/tab whose accessible name or text is <text>
//   fill <route> <label> <value> set an input/textarea by aria-label, placeholder, or <label> text, then blur
//   wait <route> <text> [ms]     wait until <text> is visible in the page (default 15000 ms)
//   shot <route> <name>          save a PNG to the evidence dir
//   config [dotted.path]         print a value from the config file this instance uses (no path: print the file path)
//   sidecar                      print how many Agent Mode sidecar processes are running
//   stop                         stop the process tree this run started; keeps evidence
// SL_FRESH_CONFIG=1 before launch: use an empty throwaway config instead (Linux only; see SKILL.md).
// State lives in .cache/verify-shuddhalekhan/ (git-ignored). Evidence goes to .cache/verify-shuddhalekhan/evidence/.
import { spawn } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { homedir } from 'os';
import { join, resolve } from 'path';

const REPO = resolve(import.meta.dir, '../../..');
const ROOT = join(REPO, '.cache/verify-shuddhalekhan');
const RUN = join(ROOT, 'run');
const EVIDENCE = join(ROOT, 'evidence');
const STATE = join(ROOT, 'state.json');
const CONFIG_AT_LAUNCH = join(ROOT, 'config-at-launch.json');
const PORT = Number(process.env.SL_CDP_PORT ?? 9339);
const WIN = process.platform === 'win32';
const SIDECAR = join(REPO, 'app', 'src', 'agent', 'index.ts');

type State = { pid: number; port: number; appData: string; fresh: boolean; startedAt: string };
const readState = (): State | null => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const die = (msg: string): never => { console.error(msg); process.exit(1); };

// Electron's appData: what store-path.ts joins 'Shuddhalekhan' onto.
const realAppData = () => (WIN ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming') : process.env.XDG_CONFIG_HOME || join(homedir(), '.config'));
const storeFile = (appData: string) => join(appData, 'Shuddhalekhan', 'shuddhalekhan-config.json');

/** Command lines of running processes that contain `needle` literally. */
function procs(needle: string): string[] {
  const out = WIN
    ? Bun.spawnSync(['powershell', '-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:SL_NEEDLE) } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'],
    { env: { ...process.env, SL_NEEDLE: needle } }).stdout.toString()
    : Bun.spawnSync(['pgrep', '-af', '--', needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]).stdout.toString();
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// Every Electron helper carries --user-data-dir, so these name the installed app and any dev instance
// on this appData — both share the settings store and the global shortcuts with ours.
const instanceMarkers = (appData: string) => [join(appData, 'Shuddhalekhan'), join(appData, '@shuddhalekhan', 'app')].map((d) => `--user-data-dir=${d}`);
const runningInstances = (appData: string) => instanceMarkers(appData).flatMap(procs);

// The app rewrites MCP discovery results whenever a server connects; those changes aren't the agent's to undo.
const APP_WRITTEN = new Set(['discoveredAt', 'discoveredTools']);
function changedPaths(a: unknown, b: unknown, path = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return [path || '(root)'];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => !APP_WRITTEN.has(k))
    .flatMap((k) => changedPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
}

async function pages(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = (await res.json()) as { type: string; url: string; title: string; webSocketDebuggerUrl: string }[];
  return list.filter((t) => t.type === 'page');
}

async function page(route: string) {
  const state = readState() ?? die('No instance from this run. Run launch first.');
  const target = (await pages(state.port)).find((t) => t.url.endsWith(`#/${route}`));
  return target ?? die(`No page for route "${route}". Run targets.`);
}

// One CDP session per call; small and stateless on purpose.
async function cdp<T>(route: string, method: string, params: object = {}): Promise<T> {
  const ws = new WebSocket((await page(route)).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ id: 1, method, params }));
  const msg = await new Promise<{ result?: T; error?: { message: string } }>((r) => {
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id === 1) r(m); };
  });
  ws.close();
  return msg.error ? die(`${method}: ${msg.error.message}`) : (msg.result as T);
}

async function evaluate(route: string, expression: string) {
  const r = await cdp<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
    route, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true },
  );
  if (r.exceptionDetails) die(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const visibleText = (text: string) => `(() => {
  const want = ${JSON.stringify(text)};
  // An open dialog is modal: confirm buttons often share a name with the control that opened them.
  const scope = [...document.querySelectorAll('[role=alertdialog],[role=dialog]')].filter((d) => d.checkVisibility()).pop() ?? document;
  const els = [...scope.querySelectorAll('button,a,[role=button],[role=tab],[role=link],[role=menuitem],[role=switch],[role=checkbox],[role=radio],[role=option],label,option')];
  return els.find((e) => (e.getAttribute('aria-label') ?? '').trim() === want && e.checkVisibility())
    ?? els.find((e) => e.textContent?.trim() === want && e.checkVisibility()) ?? null;
})()`;

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'launch': {
    const prior = readState();
    if (prior && alive(prior.pid)) die(`Instance ${prior.pid} from an earlier launch is still running. Run stop first.`);
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); die(`Port ${PORT} is taken by something else. Set SL_CDP_PORT.`); } catch {}
    const fresh = process.env.SL_FRESH_CONFIG === '1';
    if (fresh && WIN) die('SL_FRESH_CONFIG is Linux-only: on Windows Electron ignores %APPDATA% overrides. Ask the maintainer (see SKILL.md).');
    const appData = fresh ? join(RUN, 'config') : realAppData();
    const others = [...runningInstances(realAppData()), ...(fresh ? runningInstances(appData) : [])];
    if (others.length) die(`Shuddhalekhan is already running (installed app or another dev instance). Ask the maintainer to quit it from the tray; never kill it yourself.\n${others.join('\n')}`);
    rmSync(RUN, { recursive: true, force: true });
    mkdirSync(appData, { recursive: true });
    mkdirSync(EVIDENCE, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (fresh) env.XDG_CONFIG_HOME = appData;
    else if (existsSync(storeFile(appData))) copyFileSync(storeFile(appData), CONFIG_AT_LAUNCH);
    mkdirSync(RUN, { recursive: true });
    const log = openSync(join(RUN, 'app.log'), 'w');
    // The repo's own dev script (predev installs Electron); extra args land after its `--`, i.e. on Electron.
    const child = spawn('bun', ['run', 'dev', `--remote-debugging-port=${PORT}`], {
      cwd: join(REPO, 'app'), env, detached: !WIN, windowsHide: true, stdio: ['ignore', log, log],
    });
    child.unref();
    writeFileSync(STATE, JSON.stringify({ pid: child.pid!, port: PORT, appData, fresh, startedAt: new Date().toISOString() }));
    // Ready = the runtime surface (pill/toasts) has loaded. Settings opens by itself only while onboarding is pending;
    // otherwise it stays closed until the user opens it, so launch reports it instead of waiting for it.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (!alive(child.pid!)) die(`Exited during launch. See ${join(RUN, 'app.log')}`);
      try {
        const routes = (await pages(PORT)).map((t) => t.url.split('#/')[1]);
        if (routes.includes('runtime') && (await evaluate('runtime', `document.readyState === 'complete'`))) {
          await sleep(2000); // give an onboarding Settings window its moment to appear
          const settings = (await pages(PORT)).some((t) => t.url.endsWith('#/settings'));
          console.log(`ready pid=${child.pid} port=${PORT} config=${fresh ? 'fresh' : 'real'} settings=${settings ? 'open' : 'closed'} log=${join(RUN, 'app.log')}`);
          process.exit(0);
        }
      } catch {}
      await sleep(1000);
    }
    die(`Not ready after 120s. See ${join(RUN, 'app.log')}`);
  }
  case 'doctor': {
    const s = readState() ?? die('FAIL no state: nothing launched by this skill');
    if (!alive(s.pid)) die(`FAIL pid ${s.pid} is gone. Run stop, then launch.`);
    const version = (await (await fetch(`http://127.0.0.1:${s.port}/json/version`)).json()) as { Browser: string };
    const store = storeFile(s.appData);
    if (!existsSync(store)) die(`FAIL config missing at ${store}`);
    const routes = (await pages(s.port)).map((t) => t.url.split('#/')[1] ?? t.url);
    console.log(JSON.stringify({ ok: true, pid: s.pid, port: s.port, browser: version.Browser, config: s.fresh ? 'fresh' : 'real', store, routes }, null, 2));
    break;
  }
  case 'targets':
    for (const t of await pages(readState()?.port ?? PORT)) console.log(`${t.url.split('#/')[1] ?? '?'}\t${t.title}\t${t.url}`);
    break;
  case 'eval':
    console.log(JSON.stringify(await evaluate(args[0], args.slice(1).join(' ')), null, 2));
    break;
  case 'click': {
    const ok = await evaluate(args[0], `(() => { const e = ${visibleText(args[1])}; if (!e) return false; e.scrollIntoView({block:'center'}); e.click(); return true; })()`);
    if (!ok) die(`No visible control named "${args[1]}" on ${args[0]}`);
    console.log(`clicked "${args[1]}"`);
    break;
  }
  case 'fill': {
    // Sets the value the way React sees typing, then blurs (text fields save on leave).
    const ok = await evaluate(args[0], `(() => {
      const want = ${JSON.stringify(args[1])};
      const fields = [...document.querySelectorAll('input,textarea')].filter((e) => e.checkVisibility());
      const e = fields.find((f) => f.getAttribute('aria-label') === want || f.placeholder === want || [...(f.labels ?? [])].some((l) => l.textContent.trim() === want));
      if (!e) return false;
      e.focus();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value').set.call(e, ${JSON.stringify(args.slice(2).join(' '))});
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.blur();
      return true;
    })()`);
    if (!ok) die(`No visible field named "${args[1]}" on ${args[0]}`);
    console.log(`filled "${args[1]}"`);
    break;
  }
  case 'wait': {
    const deadline = Date.now() + Number(args[2] ?? 15000);
    while (Date.now() < deadline) {
      if (await evaluate(args[0], `document.body.innerText.includes(${JSON.stringify(args[1])})`)) { console.log(`saw "${args[1]}"`); process.exit(0); }
      await sleep(250);
    }
    die(`Timed out waiting for "${args[1]}" on ${args[0]}`);
  }
  case 'shot': {
    const { data } = await cdp<{ data: string }>(args[0], 'Page.captureScreenshot', { format: 'png' });
    const path = join(EVIDENCE, `${args[1]}.png`);
    writeFileSync(path, Buffer.from(data, 'base64'));
    console.log(path);
    break;
  }
  case 'open-settings': {
    // The user path: open the app again while it runs. The second process loses the single-instance lock and quits,
    // and the running instance shows Settings. Same Electron binary, app dir, and config env as launch.
    const s = readState() ?? die('No instance from this run. Run launch first.');
    if (!alive(s.pid)) die(`pid ${s.pid} is gone. Run stop, then launch.`);
    const electron: string = createRequire(join(REPO, 'app', 'package.json'))('electron');
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (s.fresh) env.XDG_CONFIG_HOME = s.appData;
    Bun.spawnSync([electron, join(REPO, 'app'), '--ozone-platform=x11'], { env, timeout: 30_000 });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await pages(s.port)).some((t) => t.url.endsWith('#/settings'))
        && (await evaluate('settings', `document.readyState === 'complete' && !!document.querySelector('h1')`).catch(() => false))) {
        console.log('settings open');
        process.exit(0);
      }
      await sleep(500);
    }
    die('Settings did not open within 15s of the second launch. Check app.log; the second-instance handler may be missing or broken.');
  }
  case 'config': {
    // Works before launch too: without a run it reads the real config.
    const store = storeFile(readState()?.appData ?? realAppData());
    if (!args[0]) { console.log(store); break; }
    const value = args[0].split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], JSON.parse(readFileSync(store, 'utf8')));
    console.log(JSON.stringify(value));
    break;
  }
  case 'sidecar':
    console.log(procs(SIDECAR).length);
    break;
  case 'stop': {
    const s = readState();
    if (!s) { console.log('nothing to stop'); break; }
    if (alive(s.pid)) {
      if (WIN) {
        // No process groups on Windows: end the tree under the bun we spawned. /F skips before-quit; SQLite WAL survives that.
        Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(s.pid)]);
      } else {
        try { process.kill(-s.pid, 'SIGTERM'); } catch {}
        for (let i = 0; i < 20 && alive(s.pid); i++) await sleep(500);
        if (alive(s.pid)) try { process.kill(-s.pid, 'SIGKILL'); } catch {}
      }
    }
    // Electron helpers exit a beat after main; launch refused to start beside another instance, so these are ours.
    const ours = () => runningInstances(s.appData);
    for (let i = 0; i < 20 && ours().length; i++) await sleep(500);
    if (ours().length) die(`Processes still running: ${ours().join('\n')}\nNot deleting state; rerun stop.`);
    if (!s.fresh && existsSync(CONFIG_AT_LAUNCH)) {
      const changed = changedPaths(JSON.parse(readFileSync(CONFIG_AT_LAUNCH, 'utf8')), JSON.parse(readFileSync(storeFile(s.appData), 'utf8')));
      console.log(changed.length
        ? `NOTE real config changed during this run:\n  ${changed.join('\n  ')}\nLaunch-time copy: ${CONFIG_AT_LAUNCH}. Set back through the UI anything you did not mean to keep.`
        : 'real config unchanged');
    }
    rmSync(STATE, { force: true });
    rmSync(RUN, { recursive: true, force: true });
    console.log(`stopped pid=${s.pid}; evidence kept in ${EVIDENCE}`);
    break;
  }
  default:
    die('usage: sl.ts launch|doctor|open-settings|targets|eval|click|fill|wait|shot|config|sidecar|stop (see header)');
}
