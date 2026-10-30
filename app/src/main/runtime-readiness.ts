export function createRuntimeReadinessBarrier(onOperational: () => void): {
  markMainReady: () => void;
  markShellPaintReady: () => void;
} {
  let mainReady = false;
  let shellPaintReady = false;
  let operational = false;

  const check = () => {
    if (operational || !mainReady || !shellPaintReady) return;
    operational = true;
    onOperational();
  };

  return {
    markMainReady() {
      mainReady = true;
      check();
    },
    markShellPaintReady() {
      shellPaintReady = true;
      check();
    },
  };
}
