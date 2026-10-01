import type { Logger } from "./logger";
import { describeError } from "./logger";

/** Call to stop receiving callbacks. Safe to call more than once. */
export type Unsubscribe = () => void;

/**
 * A set of callbacks. A callback that throws is logged and never prevents the others from running;
 * callbacks may subscribe or unsubscribe while an emit is in progress.
 */
export class Listeners<T> {
  private readonly callbacks = new Set<(value: T) => void>();

  constructor(
    private readonly logger: Logger,
    private readonly label: string
  ) {}

  get size(): number {
    return this.callbacks.size;
  }

  add(callback: (value: T) => void): Unsubscribe {
    // Wrap so the same function subscribed twice gets two independent subscriptions.
    const entry = (value: T) => callback(value);
    this.callbacks.add(entry);
    return () => {
      this.callbacks.delete(entry);
    };
  }

  emit(value: T): void {
    for (const callback of [...this.callbacks]) {
      invokeSafely(this.logger, this.label, () => callback(value));
    }
  }

  clear(): void {
    this.callbacks.clear();
  }
}

export function invokeSafely(logger: Logger, label: string, callback: () => void): void {
  try {
    callback();
  } catch (error) {
    logger.error(`${label} callback threw: ${describeError(error)}`);
  }
}
