import type { Unsubscribe } from "./listeners";
import { Listeners, invokeSafely } from "./listeners";
import type { Logger } from "./logger";
import type { TimerHandle } from "./timers";
import { startTimeout, stopTimer } from "./timers";

/**
 * A readiness signal. It starts open, and `settle` resolves everyone waiting on it: `true` means
 * ready, `false` means it will not become ready (a permanent failure, or shutdown). A latch
 * settled `false` may still settle `true` later; once `true` it stays `true`.
 */
export class Latch {
  private outcome: boolean | undefined;
  private readonly waiters = new Set<(value: boolean) => void>();
  private readonly onReadyCallbacks: Listeners<void>;

  constructor(
    private readonly logger: Logger,
    private readonly label: string
  ) {
    this.onReadyCallbacks = new Listeners(logger, label);
  }

  get isReady(): boolean {
    return this.outcome === true;
  }

  settle(ready: boolean): void {
    if (this.outcome === true) return;
    this.outcome = ready;
    for (const finish of [...this.waiters]) finish(ready);
    if (ready) this.onReadyCallbacks.emit();
    this.onReadyCallbacks.clear();
  }

  /** Resolves with the outcome, or `false` if `timeoutMs` elapses first. Never rejects. */
  wait(timeoutMs?: number): Promise<boolean> {
    if (this.outcome !== undefined) return Promise.resolve(this.outcome);
    return new Promise((resolve) => {
      let timer: TimerHandle | undefined;
      const finish = (value: boolean) => {
        stopTimer(timer);
        this.waiters.delete(finish);
        resolve(value);
      };
      this.waiters.add(finish);
      if (timeoutMs !== undefined) timer = startTimeout(() => finish(false), timeoutMs);
    });
  }

  /** Call `callback` once ready (immediately if already). Dropped if the latch settles `false`. */
  onReady(callback: () => void): Unsubscribe {
    if (this.isReady) {
      invokeSafely(this.logger, this.label, callback);
      return () => undefined;
    }
    if (this.outcome === false) return () => undefined;
    return this.onReadyCallbacks.add(callback);
  }
}
