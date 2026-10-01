/**
 * Timers that never keep a Node process alive on their own: a server that has finished its work
 * should be able to exit without first calling `shutdown()`. Browsers ignore the distinction.
 */
export type TimerHandle = ReturnType<typeof setTimeout>;

function unref(handle: TimerHandle): TimerHandle {
  const candidate = handle as unknown as { unref?: () => void };
  if (typeof candidate.unref === "function") candidate.unref();
  return handle;
}

export function startTimeout(callback: () => void, delayMs: number): TimerHandle {
  return unref(setTimeout(callback, Math.max(0, delayMs)));
}

export function startInterval(callback: () => void, intervalMs: number): TimerHandle {
  return unref(setInterval(callback, intervalMs) as unknown as TimerHandle);
}

/**
 * Stop a timeout or an interval. `clearTimeout` clears both: browsers share one id pool between
 * them (HTML spec) and Node's timer objects accept either function.
 */
export function stopTimer(handle: TimerHandle | undefined): void {
  if (handle !== undefined) clearTimeout(handle);
}

/** `base * (1 ± ratio)`, for spreading periodic requests from many instances. */
export function withJitter(baseMs: number, ratio: number): number {
  const clamped = Math.min(Math.max(ratio, 0), 1);
  return baseMs * (1 - clamped + Math.random() * 2 * clamped);
}
