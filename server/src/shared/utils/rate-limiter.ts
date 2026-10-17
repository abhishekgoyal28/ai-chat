/**
 * Fixed-window request counter per key, in process memory. Limits are per
 * pod, which is the intent: they exist to stop a runaway client or script,
 * not to meter usage exactly.
 */
export class WindowRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 50_000,
  ) {}

  /** Records one hit; false when the key is over its limit for the current window. */
  tryAcquire(key: string, now = Date.now()): boolean {
    const window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      if (this.windows.size >= this.maxKeys) {
        this.evictExpired(now);
      }
      this.windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.limit;
  }

  private evictExpired(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) {
        this.windows.delete(key);
      }
    }
    if (this.windows.size >= this.maxKeys) {
      this.windows.clear();
    }
  }
}
