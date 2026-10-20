import { appendFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { courseDir, redactPII } from "../storage";

export type ModelDiagnosticContext = { courseId: string; item: string };

export function diagnosticPreview(raw: string) {
  let safe = redactPII(raw);
  for (const [name, value] of Object.entries(process.env)) {
    if (
      /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) &&
      value &&
      value.length >= 4
    )
      safe = safe.replaceAll(value, "[密钥已隐藏]");
  }
  return safe
    .replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [已隐藏]")
    .replace(
      /((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
      "$1[已隐藏]",
    )
    .slice(0, 2000);
}

export async function recordModelDiagnostic(
  context: ModelDiagnosticContext,
  details: {
    task: string;
    provider: string;
    model: string;
    attempt: number;
    raw: string;
    error: unknown;
    normalized?: boolean;
    recovered?: boolean;
  },
) {
  const issues =
    details.error instanceof z.ZodError
      ? details.error.issues.slice(0, 30).map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: diagnosticPreview(issue.message),
        }))
      : [{ path: "", code: "invalid_json", message: "模型内容无效或截断" }];
  const { error: _error, raw, ...metadata } = details;
  try {
    const file = path.join(
      courseDir(context.courseId),
      "model-diagnostics.ndjson",
    );
    await appendFile(
      file,
      JSON.stringify({
        at: new Date().toISOString(),
        ...context,
        ...metadata,
        issues,
        rawLength: raw.length,
        rawPreview: diagnosticPreview(raw),
        truncated: raw.length > 2000,
      }) + "\n",
      { mode: 0o600 },
    );
    console.warn(
      JSON.stringify({
        event: details.recovered
          ? "model_output_normalized"
          : "model_output_invalid",
        ...context,
        ...metadata,
        issues,
        diagnostic: `courses/${context.courseId}/model-diagnostics.ndjson`,
      }),
    );
  } catch {
    console.warn(
      JSON.stringify({
        event: "model_diagnostic_write_failed",
        ...context,
        issues,
      }),
    );
  }
}
