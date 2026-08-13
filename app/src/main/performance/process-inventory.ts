export type ElectronMetricIdentity = {
  pid: number;
  type: string;
  name?: string;
};

export type ElectronWindowIdentity = {
  webContentsId: number;
  pid: number;
  url: string;
};

export function buildElectronProcessInventory(
  metrics: ElectronMetricIdentity[],
  windows: ElectronWindowIdentity[],
): {
  processes: Array<{ pid: number; role: string }>;
  windows: Array<{ webContentsId: number; pid: number; surface: string }>;
} {
  return {
    processes: metrics.map((metric) => ({
      pid: metric.pid,
      role: electronRole(metric.type),
    })),
    windows: windows.map((window) => ({
      webContentsId: window.webContentsId,
      pid: window.pid,
      surface: surfaceFromUrl(window.url),
    })),
  };
}

function electronRole(type: string): string {
  const normalized = type.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (normalized === 'browser') return 'electron-main';
  if (normalized === 'tab') return 'electron-renderer';
  return `electron-${normalized || 'other'}`;
}

function surfaceFromUrl(url: string): string {
  const hash = url.split('#')[1]?.replace(/^\/?/, '') ?? '';
  return hash.split('?')[0] || 'unknown';
}
