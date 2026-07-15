/** A timeout-aware correlation map for request/response protocols. */
export class PendingRequestMap<Id, Value> {
  private readonly pending = new Map<
    Id,
    {
      resolve: (value: Value) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  create(id: Id, timeoutMs: number, timeoutMessage: string): Promise<Value> {
    // Silently overwriting would orphan the old entry's promise and leave its
    // timer racing against the new entry's — surface the caller bug instead.
    if (this.pending.has(id)) throw new Error(`Duplicate pending request id: ${String(id)}`);
    return new Promise<Value>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  resolve(id: Id, value: Value): boolean {
    const entry = this.take(id);
    if (!entry) return false;
    entry.resolve(value);
    return true;
  }

  reject(id: Id, error: Error): boolean {
    const entry = this.take(id);
    if (!entry) return false;
    entry.reject(error);
    return true;
  }

  delete(id: Id): void {
    const entry = this.pending.get(id);
    if (entry) clearTimeout(entry.timer);
    this.pending.delete(id);
  }

  rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private take(id: Id) {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    return entry;
  }
}
