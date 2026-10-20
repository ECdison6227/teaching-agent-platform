export const MODEL_TIMEOUT_MS = 120_000;

/** 将页面断开、用户停止与总时限传给同一个上游请求。 */
export function requestScope(
  parent?: AbortSignal,
  timeoutMs = MODEL_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("模型响应超时，请重试", "TimeoutError"),
      ),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    abort: () => controller.abort(new DOMException("请求已停止", "AbortError")),
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

export function requestError(error: unknown, signal?: AbortSignal): string {
  const reason = signal?.aborted ? signal.reason : error;
  if (reason instanceof Error && reason.name === "TimeoutError")
    return "模型响应超时，请重试";
  if (reason instanceof Error && reason.name === "AbortError")
    return "请求已停止";
  return error instanceof Error ? error.message : "请求失败，请稍后重试";
}
