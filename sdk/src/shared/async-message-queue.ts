/**
 * Single-consumer asynchronous queue used by protocol connection pull surfaces.
 *
 * With `buffer` set to `false` a pushed value is handed to a pending
 * `next()` waiter or discarded; nothing is ever stored for a later drain.
 */
export class AsyncMessageQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: T | null) => void> = [];
  private closed = false;
  private warned = false;

  constructor(
    private readonly highWaterMark = 1000,
    private readonly onHighWater?: (size: number) => void,
    private readonly buffer = true,
  ) {}

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else if (this.buffer) {
      this.values.push(value);
      if (!this.warned && this.values.length >= this.highWaterMark) {
        this.warned = true;
        this.onHighWater?.(this.values.length);
      }
    }
  }

  next(): Promise<T | null> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(clear = true): void {
    this.closed = true;
    if (clear) this.values = [];
    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
  }

  reopen(): void {
    this.closed = false;
    this.warned = false;
  }
}
