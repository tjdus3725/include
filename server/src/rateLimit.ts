/** 단순 토큰 버킷. key 별로 capacity 만큼 버스트를 허용하고 refillMs 마다 1개씩 채웁니다. */
export class TokenBucket {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  constructor(
    private capacity: number,
    private refillMs: number,
  ) {
    setInterval(() => this.sweep(), 60_000).unref();
  }
  /** 성공하면 0, 실패하면 다시 시도할 수 있을 때까지 남은 ms */
  take(key: string, cost = 1): number {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.updated) / this.refillMs);
    b.updated = now;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      this.buckets.set(key, b);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.ceil((cost - b.tokens) * this.refillMs);
  }
  delete(key: string) {
    this.buckets.delete(key);
  }
  private sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (now - b.updated > this.capacity * this.refillMs * 2) this.buckets.delete(k);
  }
}
