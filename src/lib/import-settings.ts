const MAX_TIMEOUT = 2_147_483_647;

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT
    ? value
    : fallback;
}

export function importPageConcurrency() {
  return Math.min(16, positiveInteger("IMPORT_PAGE_CONCURRENCY", 4));
}

export function importCommandTimeout(bin: string, pageCount = 1) {
  const count =
    Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : 1;
  switch (bin) {
    case "soffice":
      return positiveInteger("IMPORT_SOFFICE_TIMEOUT_MS", 900_000);
    case "pdfinfo":
      return positiveInteger("IMPORT_PDFINFO_TIMEOUT_MS", 120_000);
    case "pdftoppm":
    case "pdftotext": {
      const prefix = `IMPORT_${bin.toUpperCase()}`;
      return Math.min(
        MAX_TIMEOUT,
        positiveInteger(`${prefix}_TIMEOUT_MS`, 120_000) +
          count *
            positiveInteger(
              `${prefix}_PER_PAGE_TIMEOUT_MS`,
              bin === "pdftoppm" ? 30_000 : 10_000,
            ),
      );
    }
    default:
      return positiveInteger("IMPORT_COMMAND_TIMEOUT_MS", 120_000);
  }
}

/** 结果保持原页序；异常时等在途页结束，避免任务失败后仍有后台写入。 */
export async function mapImportPages<T, R>(
  items: readonly T[],
  work: (item: T, index: number) => Promise<R>,
  onComplete: (completed: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let completed = 0;
  let failed = false;
  const workers = Array.from(
    { length: Math.min(importPageConcurrency(), items.length) },
    async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await work(items[index], index);
          onComplete(++completed);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    },
  );
  const settled = await Promise.allSettled(workers);
  for (const result of settled)
    if (result.status === "rejected") throw result.reason;
  return results;
}
