export function abortableDelay(ms, { signal, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const onAbort = () => {
      clearTimeoutFn(timer);
      cleanup();
      reject(signal.reason ?? new Error('aborted'));
    };
    timer = setTimeoutFn(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
