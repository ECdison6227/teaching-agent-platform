import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { database } from "@/db";
import { pages } from "@/db/schema";
import { storagePath } from "@/lib/storage";
export const runtime = "nodejs";
export async function GET(
  _: Request,
  context: { params: Promise<{ courseId: string; page: string }> },
) {
  const { courseId, page } = await context.params;
  if (!/^\d+$/.test(page))
    return Response.json({ error: "页码无效" }, { status: 404 });
  const row = database()
    .db.select()
    .from(pages)
    .where(and(eq(pages.courseId, courseId), eq(pages.index, Number(page))))
    .get();
  if (!row) return Response.json({ error: "页面不存在" }, { status: 404 });
  try {
    return new Response(await readFile(storagePath(row.imageKey)), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "页图尚未生成" }, { status: 404 });
  }
}
