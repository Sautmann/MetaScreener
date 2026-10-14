/**
 * Client-side rate limiting for synchronous requests.
 *
 * OpenAI limits requests per minute (RPM) and tokens per minute (TPM) per model and organisation.
 * Tokens are counted at request time as prompt tokens + max output tokens. This limiter keeps a
 * rolling 60-second window per model that all parallel requests (and all jobs in this tab) share,
 * and can be paused globally when OpenAI answers 429 or reports that a limit is nearly used up.
 */

export type RateLimits = { rpm: number; tpm: number };

export const DEFAULT_RATE_LIMITS: RateLimits = { rpm: 500, tpm: 200_000 };

const WINDOW_MS = 60_000;

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Parse OpenAI reset durations such as "1s", "6m0s", "20ms", "1h2m3.5s" */
export function parseResetDuration(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  let total = 0;
  let matched = false;
  for (const m of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n;
  }
  return matched ? total : undefined;
}

type Reservation = { at: number; tokens: number };

export class RateLimiter {
  private window: Reservation[] = [];
  private pausedUntil = 0;
  // FIFO: requests acquire in order, so large requests are not starved by small ones
  private queue: Promise<void> = Promise.resolve();

  limits: RateLimits;

  constructor(limits: RateLimits) {
    this.limits = limits;
  }

  /** Stop all requests on this limiter until `ms` from now (e.g. after a 429) */
  pauseFor(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  get pausedMs(): number {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  /**
   * Wait until a request of `tokens` fits in the current window, then reserve it.
   * Returns a function to replace the estimate with the actual token count once known.
   */
  acquire(tokens: number, signal?: AbortSignal): Promise<(actualTokens: number) => void> {
    const result = this.queue.then(() => this.waitAndReserve(tokens, signal));
    // Keep the chain going even if this acquisition is aborted
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async waitAndReserve(tokens: number, signal?: AbortSignal) {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const now = Date.now();
      if (now < this.pausedUntil) {
        await abortableSleep(this.pausedUntil - now, signal);
        continue;
      }
      this.window = this.window.filter((r) => now - r.at < WINDOW_MS);
      const usedTokens = this.window.reduce((sum, r) => sum + r.tokens, 0);
      const fitsRequests = this.window.length + 1 <= this.limits.rpm;
      // A single request larger than the TPM limit is let through on an empty window;
      // OpenAI will reject it as too large and that paper is reported as failed.
      const fitsTokens = usedTokens + tokens <= this.limits.tpm || this.window.length === 0;
      if (fitsRequests && fitsTokens) {
        const reservation = { at: now, tokens };
        this.window.push(reservation);
        return (actualTokens: number) => {
          if (Number.isFinite(actualTokens) && actualTokens > 0) reservation.tokens = actualTokens;
        };
      }
      // Wait until the oldest reservation leaves the window
      const oldest = this.window[0];
      await abortableSleep(oldest ? oldest.at + WINDOW_MS - now + 50 : 250, signal);
    }
  }
}

const limiters = new Map<string, RateLimiter>();

/** One limiter per model, shared across jobs; limits are updated to the latest job's settings */
export function getRateLimiter(model: string, limits: RateLimits): RateLimiter {
  let limiter = limiters.get(model);
  if (!limiter) {
    limiter = new RateLimiter(limits);
    limiters.set(model, limiter);
  } else {
    limiter.limits = limits;
  }
  return limiter;
}
