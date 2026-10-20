import { HttpError, MAX_UPLOAD_BYTES, saveSource } from "@/lib/courses";
import { api } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  return api(async () => {
    const { courseId } = await context.params;
    if (
      Number(request.headers.get("content-length")) >
      MAX_UPLOAD_BYTES + 1024 * 1024
    )
      throw new HttpError(413, "文件超过 200 MB");
    // 限制流的实际大小，不能只信任 Content-Length。
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, "请选择文件");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_UPLOAD_BYTES + 1024 * 1024) {
          await reader.cancel();
          throw new HttpError(413, "文件超过 200 MB");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const form = await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": request.headers.get("content-type") || "" },
    }).formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "请选择文件");
    return saveSource(
      courseId,
      form.get("kind"),
      file.name,
      Buffer.from(await file.arrayBuffer()),
    );
  }, 201);
}
