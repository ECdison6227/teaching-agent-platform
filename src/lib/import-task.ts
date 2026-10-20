/** Import helpers also run independently in tests/tools without a queue lease. */
export type ImportHooks = {
  progress: (value: number, step: string) => void;
  tokens: (amount: number) => void;
  signal?: AbortSignal;
  write?: <T>(work: () => T) => T;
};

export function importWrite<T>(hooks: ImportHooks, work: () => T): T {
  hooks.signal?.throwIfAborted();
  return hooks.write ? hooks.write(work) : work();
}
