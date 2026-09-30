/** Destination for SDK log lines. Defaults to the console; override to route into your own logger. */
export interface GamebeastLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const PREFIX = "[Gamebeast] ";

const consoleLogger: GamebeastLogger = {
  debug: (message) => console.debug(PREFIX + message),
  warn: (message) => console.warn(PREFIX + message),
  error: (message) => console.error(PREFIX + message),
};

/**
 * SDK-internal logger. Debug lines are gated behind the `debug` option; warnings and errors always
 * surface, because they describe data the SDK dropped or a misconfiguration the developer must fix.
 */
export class Logger {
  private readonly warnedOnce = new Set<string>();

  constructor(
    private readonly sink: GamebeastLogger = consoleLogger,
    private readonly debugEnabled = false
  ) {}

  debug(message: string): void {
    if (this.debugEnabled) this.safe(() => this.sink.debug(message));
  }

  warn(message: string): void {
    this.safe(() => this.sink.warn(message));
  }

  error(message: string): void {
    this.safe(() => this.sink.error(message));
  }

  /** Warn at most once per `key` for the lifetime of this logger. */
  warnOnce(key: string, message: string): void {
    if (this.warnedOnce.has(key)) return;
    this.warnedOnce.add(key);
    this.warn(message);
  }

  /** A custom sink that throws must never break the SDK call that was logging. */
  private safe(write: () => void): void {
    try {
      write();
    } catch {
      // Ignore: logging is best-effort.
    }
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
