export type DictationTargetSnapshot = {
  kind: 'win32';
  hwnd: number;
  processId: number;
  processCreationTime: string;
  threadId: number;
  windowClass: string;
  executablePath: string | null;
  capturedAt: string;
} | {
  kind: 'x11';
  windowId: number;
  processId: number;
  processStartTime: string;
  executablePath: string | null;
  capturedAt: string;
} | {
  /** KWin window active at record start; `epoch` changes on every activation, so focus returning never revives it. */
  kind: 'kde-wayland';
  windowId: string;
  epoch: number;
  appId: string;
  capturedAt: string;
};
