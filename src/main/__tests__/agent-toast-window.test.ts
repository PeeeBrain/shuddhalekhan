import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { electronMock, installElectronMock, resetElectronMock } from '../../test/electron-mock';

installElectronMock();

describe('agent toast sizing', () => {
  beforeEach(() => {
    resetElectronMock();
  });

  it('grows gradually with streamed content and keeps the bottom-right anchor', async () => {
    const { calculateToastBounds } = await import(`../agent-toast-window?test=${Date.now()}-growth`);
    const workArea = { x: 0, y: 0, width: 1440, height: 900 };

    const small = calculateToastBounds(workArea, { isApproval: false, contentHeight: 150 });
    const medium = calculateToastBounds(workArea, { isApproval: false, contentHeight: 280 });
    const large = calculateToastBounds(workArea, { isApproval: false, contentHeight: 420 });

    expect(small.height).toBe(190);
    expect(medium.height).toBe(280);
    expect(large.height).toBe(420);
    expect(small.x).toBe(medium.x);
    expect(medium.x).toBe(large.x);
    expect(small.y + small.height).toBe(workArea.height - 24);
    expect(medium.y + medium.height).toBe(workArea.height - 24);
    expect(large.y + large.height).toBe(workArea.height - 24);
  });

  it('clamps streamed toast growth at the max height', async () => {
    const { calculateToastBounds } = await import(`../agent-toast-window?test=${Date.now()}-clamp`);
    const bounds = calculateToastBounds(
      { x: 0, y: 0, width: 1440, height: 900 },
      { isApproval: false, contentHeight: 900 }
    );

    expect(bounds.height).toBe(520);
    expect(bounds.y + bounds.height).toBe(876);
  });

  it('keeps approval toasts fixed size instead of applying dynamic content sizing', async () => {
    const { calculateToastBounds } = await import(`../agent-toast-window?test=${Date.now()}-approval`);
    const bounds = calculateToastBounds(
      { x: 0, y: 0, width: 1440, height: 900 },
      { isApproval: true, contentHeight: 900 }
    );

    expect(bounds).toEqual({
      x: 956,
      y: 566,
      width: 460,
      height: 310,
    });
  });

  it('updates streaming content in place without re-showing or compact-positioning each token', async () => {
    const setBounds = mock();
    const showInactive = mock(() => {
      visible = true;
    });
    const send = mock();
    let visible = false;

    electronMock.screen.getPrimaryDisplay.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    });
    electronMock.BrowserWindow.mockImplementation(() => ({
      setBounds,
      showInactive,
      hide: mock(() => {
        visible = false;
      }),
      isVisible: mock(() => visible),
      isDestroyed: mock(() => false),
      setAlwaysOnTop: mock(),
      loadURL: mock(),
      loadFile: mock(),
      on: mock(),
      webContents: {
        isLoading: mock(() => false),
        send,
        on: mock(),
      },
    }));

    const { showAgentToast } = await import(`../agent-toast-window?test=${Date.now()}-streaming-in-place`);

    showAgentToast({ kind: 'streaming', agentRunId: 'run-1', response: 'One' });
    showAgentToast({ kind: 'streaming', agentRunId: 'run-1', response: 'One two' });
    showAgentToast({ kind: 'streaming', agentRunId: 'run-1', response: 'One two three' });

    expect(setBounds).toHaveBeenCalledTimes(1);
    expect(showInactive).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('does not show a streaming toast for blank streamed content', async () => {
    const showInactive = mock();
    const send = mock();

    electronMock.BrowserWindow.mockImplementation(() => ({
      setBounds: mock(),
      showInactive,
      hide: mock(),
      isVisible: mock(() => false),
      isDestroyed: mock(() => false),
      setAlwaysOnTop: mock(),
      loadURL: mock(),
      loadFile: mock(),
      on: mock(),
      webContents: {
        isLoading: mock(() => false),
        send,
        on: mock(),
      },
    }));

    const { showAgentToast } = await import(`../agent-toast-window?test=${Date.now()}-blank-streaming`);

    showAgentToast({ kind: 'streaming', agentRunId: 'run-1', response: '   \n' });

    expect(showInactive).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('coalesces small streaming resize changes to avoid repaint flicker', async () => {
    const setBounds = mock();
    let visible = true;

    electronMock.screen.getPrimaryDisplay.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    });
    electronMock.BrowserWindow.mockImplementation(() => ({
      setBounds,
      showInactive: mock(() => {
        visible = true;
      }),
      hide: mock(() => {
        visible = false;
      }),
      isVisible: mock(() => visible),
      isDestroyed: mock(() => false),
      setAlwaysOnTop: mock(),
      loadURL: mock(),
      loadFile: mock(),
      on: mock(),
      webContents: {
        isLoading: mock(() => false),
        send: mock(),
        on: mock(),
      },
    }));

    const { handleAgentToastContentSize, showAgentToast } = await import(`../agent-toast-window?test=${Date.now()}-coalesce`);

    showAgentToast({ kind: 'streaming', agentRunId: 'run-1', response: 'One' });
    handleAgentToastContentSize(198);
    handleAgentToastContentSize(203);
    handleAgentToastContentSize(207);
    handleAgentToastContentSize(230);

    expect(setBounds).toHaveBeenCalledTimes(2);
    expect(setBounds.mock.calls[1]?.[0]).toEqual({
      x: 996,
      y: 646,
      width: 420,
      height: 230,
    });
    expect(setBounds.mock.calls[1]?.[1]).toBe(false);
  });
});
