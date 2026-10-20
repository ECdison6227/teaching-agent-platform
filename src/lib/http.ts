import { ZodError } from "zod";
import { HttpError } from "./courses";
export async function api(
  action: () => unknown | Promise<unknown>,
  status = 200,
) {
  try {
    return Response.json(await action(), { status });
  } catch (error) {
    const code =
      error instanceof HttpError
        ? error.status
        : error instanceof ZodError || error instanceof SyntaxError
          ? 400
          : 500;
    const message =
      error instanceof HttpError
        ? error.message
        : error instanceof ZodError
          ? error.issues.map((i) => i.message).join("；")
          : code === 400
            ? "请求格式错误"
            : "服务处理失败，请查看本地日志";
    if (code === 500) console.error(error);
    return Response.json({ error: message }, { status: code });
  }
}
export async function readJson(
  request: Request,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new HttpError(413, "请求过大");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "请求为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "请求过大");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
