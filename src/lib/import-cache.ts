import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { PageNoteSchema } from "./import-schemas";
import { storagePath } from "./storage";
import type { PageNoteResult } from "./import-page-notes";

export type ParsedPage = {
  text: string;
  imageKey: string;
  width: number;
  height: number;
  cachedNote?: PageNoteResult;
};
const CachedPage = z.object({
  text: z.string(),
  imageKey: z.string(),
  width: z.number().positive(),
  height: z.number().positive(),
  cachedNote: z
    .object({
      note: PageNoteSchema,
      model: z.string(),
      tokens: z.number(),
      ruleBased: z.boolean(),
      metrics: z.object({
        requests: z.number(),
        networkRetries: z.number(),
        parseRetries: z.number(),
        rateLimits: z.number(),
        serverErrors: z.number(),
        elapsedMs: z.number(),
      }),
    })
    .optional(),
});
export async function readCachedPage(key: string) {
  try {
    const page = CachedPage.parse(
      JSON.parse(await readFile(storagePath(key), "utf8")),
    );
    await readFile(storagePath(page.imageKey));
    return page;
  } catch {
    return null;
  }
}
export async function cachePage(key: string, page: ParsedPage) {
  const file = storagePath(key);
  await writeFile(`${file}.tmp`, JSON.stringify(page));
  await rename(`${file}.tmp`, file);
}
