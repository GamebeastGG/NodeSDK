/** Rejection reason for server SDK calls that return data the caller depends on. */
export class GamebeastError extends Error {
  /** HTTP status, when the backend answered. */
  readonly status: number | undefined;
  /** Backend `errorCode`, when provided (e.g. `RATE_LIMITED`, `PERMISSION_DENIED`). */
  readonly errorCode: string | undefined;
  /** Whether retrying later may succeed. */
  readonly retryable: boolean;

  constructor(
    message: string,
    details: { status?: number; errorCode?: string; retryable?: boolean } = {}
  ) {
    super(`[Gamebeast] ${message}`);
    this.name = "GamebeastError";
    this.status = details.status;
    this.errorCode = details.errorCode;
    this.retryable = details.retryable ?? false;
  }
}
