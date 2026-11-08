// Token bucket: `perMinute` sustained, with a small burst allowance.
export class RateLimiter {
  constructor(perMinute, { burst = 5, now = () => Date.now(), sleep } = {}) {
    this.interval = 60000 / Math.max(1, perMinute);
    this.capacity = burst;
    this.tokens = burst;
    this.now = now;
    this.last = now();
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.queue = Promise.resolve();
  }

  refill() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) / this.interval);
    this.last = t;
  }

  // Resolves when the caller may send one request. Calls are served FIFO.
  take() {
    const run = async () => {
      this.refill();
      while (this.tokens < 1) {
        await this.sleep(Math.ceil((1 - this.tokens) * this.interval));
        this.refill();
      }
      this.tokens -= 1;
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }

  // Back off everyone, e.g. after a 429.
  penalize(ms) {
    this.tokens = Math.min(this.tokens, 0) - ms / this.interval;
  }
}
