/** SSE 数据解码：首页与模型适配器共用，支持 LF、CRLF、CR 和任意字节分块。 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      if (
        buffer.length + data.reduce((n, line) => n + line.length, 0) >
        1_000_000
      ) {
        throw new Error("流式响应过大，请缩短问题后重试");
      }
      while (buffer.length) {
        const newline = buffer.search(/[\r\n]/);
        if (newline < 0 && !done) break;
        if (!done && newline === buffer.length - 1 && buffer[newline] === "\r")
          break;
        const line = newline < 0 ? buffer : buffer.slice(0, newline);
        const width = buffer.slice(newline, newline + 2) === "\r\n" ? 2 : 1;
        buffer = newline < 0 ? "" : buffer.slice(newline + width);
        if (line === "") {
          if (data.length) {
            yield data.join("\n");
            data = [];
          }
        } else if (line === "data" || line.startsWith("data:")) {
          data.push(line === "data" ? "" : line.slice(5).replace(/^ /, ""));
        }
      }
      if (done) {
        if (data.length) yield data.join("\n");
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
