/** Single-consumer asynchronous queue used by protocol connection pull surfaces. */
export class AsyncMessageQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: T | null) => void> = [];
  private closed = false;
  private warned = false;

  /**
   * @param maxBuffered Hard cap on buffered values. Once reached, pushing
   * discards the oldest value so a queue with no consumer cannot grow without
   * bound. Omit for an unbounded queue.
   */
  constructor(
    private readonly highWaterMark = 1000,
    private readonly onHighWater?: (size: number) => void,
    private readonly maxBuffered?: number,
  ) {}

  /** Number of values buffered because no consumer was waiting. */
  get size(): number {
    return this.values.length;
  }

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else {
      this.values.push(value);
      if (this.maxBuffered !== undefined)
        while (this.values.length > this.maxBuffered) this.values.shift();
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
