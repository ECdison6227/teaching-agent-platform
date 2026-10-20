import type { ProviderConfig } from "./provider";

export function providerSetting(
  cfg: ProviderConfig,
  name: string,
  fallback: number,
  min = 0,
) {
  const prefix =
    cfg.id === "openai-compatible" ? "OPENAI" : cfg.id.toUpperCase();
  const raw = process.env[`${prefix}_${name}`] ?? process.env[`MODEL_${name}`];
  const value = Number(raw);
  return raw?.trim() && Number.isSafeInteger(value) && value >= min
    ? value
    : fallback;
}

export function retryAfterMs(value: string | null, now = Date.now()) {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

type Waiter = {
  resolve: (release: (success?: boolean) => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
};

/** All tasks/models on one channel share admission, RPM pacing and 429 cooldown. */
export class ModelScheduler {
  private active = 0;
  private limit: number;
  private nextStart = 0;
  private blockedUntil = 0;
  private lastLimitAt = 0;
  private successes = 0;
  private queue: Waiter[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly maximum: number,
    private readonly rpm = 0,
    private readonly recoverySuccesses = 8,
    private readonly recoveryMs = 30_000,
  ) {
    this.limit = maximum;
  }

  get concurrency() {
    return this.limit;
  }

  rateLimited(waitMs: number) {
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.successes = 0;
    this.lastLimitAt = Date.now();
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + waitMs);
    this.pump();
  }

  acquire(signal?: AbortSignal): Promise<(success?: boolean) => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          this.queue = this.queue.filter((item) => item !== waiter);
          reject(signal?.reason);
          this.pump();
        },
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
      this.pump();
    });
  }

  private pump() {
    clearTimeout(this.timer);
    while (this.queue.length && this.active < this.limit) {
      const wait = Math.max(this.blockedUntil, this.nextStart) - Date.now();
      if (wait > 0) {
        this.timer = setTimeout(
          () => this.pump(),
          Math.min(2_147_483_647, wait),
        );
        return;
      }
      const waiter = this.queue.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.abort);
      this.active++;
      if (this.rpm) this.nextStart = Date.now() + 60_000 / this.rpm;
      let released = false;
      waiter.resolve((success = false) => {
        if (released) return;
        released = true;
        this.active--;
        if (success && this.limit < this.maximum) {
          this.successes++;
          if (
            this.successes >= this.recoverySuccesses &&
            Date.now() - this.lastLimitAt >= this.recoveryMs
          ) {
            this.limit++;
            this.successes = 0;
            this.lastLimitAt = Date.now();
          }
        }
        this.pump();
      });
    }
  }
}

const shared = globalThis as typeof globalThis & {
  modelSchedulers?: Map<string, ModelScheduler>;
};
const schedulers = (shared.modelSchedulers ??= new Map());
export function modelScheduler(cfg: ProviderConfig) {
  const maximum = Math.min(32, providerSetting(cfg, "CONCURRENCY", 4, 1));
  const rpm = providerSetting(cfg, "RPM", 0);
  const successes = providerSetting(cfg, "RECOVERY_SUCCESSES", 8, 1);
  const recoveryMs = providerSetting(cfg, "RECOVERY_MS", 30_000);
  const key = JSON.stringify([
    cfg.id,
    cfg.baseUrl,
    maximum,
    rpm,
    successes,
    recoveryMs,
  ]);
  let scheduler = schedulers.get(key);
  if (!scheduler) {
    scheduler = new ModelScheduler(maximum, rpm, successes, recoveryMs);
    schedulers.set(key, scheduler);
  }
  return scheduler;
}
