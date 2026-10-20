import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { database } from "@/db";
import { sources } from "@/db/schema";
import { storagePath } from "@/lib/storage";
export const runtime = "nodejs";
export async function GET(
  _: Request,
  context: { params: Promise<{ courseId: string; sourceId: string }> },
) {
  const { courseId, sourceId } = await context.params;
  const source = database()
    .db.select()
    .from(sources)
    .where(and(eq(sources.courseId, courseId), eq(sources.id, sourceId)))
    .get();
  if (!source?.pdfKey)
    return Response.json({ error: "PDF 尚未生成" }, { status: 404 });
  try {
    return new Response(await readFile(storagePath(source.pdfKey)), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="material.pdf"; filename*=UTF-8''${encodeURIComponent(source.filename.replace(/\.[^.]+$/, ".pdf"))}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return Response.json({ error: "文件不存在" }, { status: 404 });
  }
}
