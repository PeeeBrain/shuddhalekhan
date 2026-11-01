import { useCallback, useEffect, useRef, useState } from 'react';
import type { ManagedLocalModelSnapshot } from '../../types/ipc';
import type { SettingsIpc } from './settings-ipc';

const REFRESH_COALESCE_MS = 200;

/**
 * Managed Local snapshot for Settings and Onboarding. State events can concern any
 * model/backend artifact, so they trigger a coalesced full refetch instead of being
 * merged into the selected model's state. Pass a `refreshKey` that changes with the
 * user's model/device selection to refetch when it changes.
 */
export function useManagedLocalSnapshot(settingsIpc: SettingsIpc, refreshKey: string) {
  const [snapshot, setSnapshot] = useState<ManagedLocalModelSnapshot | null>(null);
  const [loadError, setLoadError] = useState(false);
  const revision = useRef(0);

  const refresh = useCallback(() => {
    const request = ++revision.current;
    return settingsIpc.getManagedLocalModel().then((next) => {
      if (request !== revision.current) return;
      setSnapshot(next);
      setLoadError(false);
    }, () => {
      if (request === revision.current) setLoadError(true);
    });
  }, [settingsIpc]);

  /** Adopt a snapshot returned by install/delete; drops any older in-flight refetch. */
  const accept = useCallback((next: ManagedLocalModelSnapshot) => {
    revision.current++;
    setSnapshot(next);
    setLoadError(false);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    void refresh();
    const off = settingsIpc.onManagedLocalModelStateChanged(() => {
      timer ??= setTimeout(() => {
        timer = undefined;
        void refresh();
      }, REFRESH_COALESCE_MS);
    });
    return () => {
      clearTimeout(timer);
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- This is a request counter, not a DOM ref. Invalidate late replies on cleanup.
      revision.current++;
      off?.();
    };
  }, [settingsIpc, refresh, refreshKey]);

  return { snapshot, loadError, refresh, accept };
}
