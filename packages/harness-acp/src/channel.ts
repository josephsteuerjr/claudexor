/** Bounded hand-off: a slow transcript consumer backpressures the child pipe. */
export class Channel<T> {
  private values: T[] = [];
  private waiters = new Set<() => void>();
  closed = false;

  constructor(private readonly capacity = 16) {}

  private wake() {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  private async wait(signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("ACP cancelled");
    let resume!: () => void;
    const ready = new Promise<void>((resolve) => {
      resume = resolve;
    });
    this.waiters.add(resume);
    signal?.addEventListener("abort", resume, { once: true });
    try {
      await ready;
    } finally {
      signal?.removeEventListener("abort", resume);
      this.waiters.delete(resume);
    }
  }

  async push(value: T, signal?: AbortSignal) {
    while (!this.closed && !signal?.aborted && this.values.length >= this.capacity)
      await this.wait(signal);
    if (this.closed || signal?.aborted) throw new Error("ACP channel closed");
    this.values.push(value);
    this.wake();
  }

  async *read(): AsyncGenerator<T> {
    while (!this.closed || this.values.length) {
      if (!this.values.length) {
        await this.wait();
        continue;
      }
      const value = this.values.shift()!;
      this.wake();
      yield value;
    }
  }

  close() {
    this.closed = true;
    this.wake();
  }
}
