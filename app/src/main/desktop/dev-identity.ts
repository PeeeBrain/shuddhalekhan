import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const NAME = 'shuddhalekhan.desktop';
const MARKER = '# Shuddhalekhan development identity';

/** The host portal registry resolves app IDs through installed desktop files, even in dev. */
export function prepareDevelopmentIdentity(options: {
  executable: string;
  appPath: string;
  dataHome?: string;
  dataDirs?: string[];
}): () => void {
  const dataHome = options.dataHome ?? process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  const dataDirs = options.dataDirs ?? (process.env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share').split(':');
  const path = join(dataHome, 'applications', NAME);
  if (dataDirs.some(dir => existsSync(join(dir, 'applications', NAME)))) return () => {};
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    const pid = Number(new RegExp(`^${MARKER} (\\d+) `).exec(existing)?.[1]);
    if (!pid) return () => {};
    try { process.kill(pid, 0); return () => {}; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) return () => {};
    }
    rmSync(path);
  }
  const quote = (value: string) => {
    if (/[\r\n\0]/.test(value)) throw new Error('Development executable path contains a control character.');
    return `"${value.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&')}"`;
  };
  const command = `${quote(options.executable)} ${quote(options.appPath)}`.replace(/\\/g, '\\\\');
  const content = `${MARKER} ${process.pid} ${randomUUID()}\n[Desktop Entry]\nType=Application\nName=Shuddhalekhan (development)\nExec=${command}\nNoDisplay=true\n`;
  mkdirSync(join(dataHome, 'applications'), { recursive: true });
  try { writeFileSync(path, content, { flag: 'wx', mode: 0o644 }); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return () => {};
    throw error;
  }
  return () => {
    try {
      if (readFileSync(path, 'utf8') === content) rmSync(path);
    } catch { /* A replacement or removed desktop file belongs to its new owner. */ }
  };
}
