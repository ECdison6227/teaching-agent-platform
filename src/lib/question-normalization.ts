import { normalizeQuestion } from "./question-parser";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}
function field(value: RecordValue, ...keys: string[]) {
  return keys.map((key) => value[key]).find((item) => item !== undefined);
}
function text(value: unknown): unknown {
  return (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
    ? String(value)
    : value;
}
function number(value: unknown): unknown {
  return typeof value === "string" &&
    value.trim() &&
    Number.isFinite(Number(value))
    ? Number(value)
    : value;
}
function options(value: unknown): unknown {
  if (value == null || (Array.isArray(value) && !value.length))
    return undefined;
  const mapped = record(value);
  const entries = mapped
    ? Object.entries(mapped).map(([id, value]) =>
        record(value) ? { ...record(value), id } : { id, text: value },
      )
    : value;
  if (!Array.isArray(entries)) return entries;
  return entries.map((option, index) => {
    if (typeof option === "string" || typeof option === "number") {
      const raw = String(option);
      const match = raw.match(
        /^\s*[(（]?([A-LＡ-Ｌ])[)）.．、:：]\s*([\s\S]*)$/i,
      );
      return {
        id:
          match?.[1]?.normalize("NFKC").toUpperCase() ||
          String.fromCharCode(65 + index),
        text: match?.[2] ?? raw,
      };
    }
    const o = record(option);
    if (!o) return option;
    return {
      id: text(
        field(o, "id", "key", "label", "letter", "optionId", "option_id") ??
          String.fromCharCode(65 + index),
      ),
      text: text(
        field(o, "text", "content", "value", "description", "option", "选项"),
      ),
    };
  });
}
function answer(value: unknown): unknown {
  if (!Array.isArray(value)) return text(value);
  if (!value.length) return null;
  return value.every((item) =>
    ["string", "number", "boolean"].includes(typeof item),
  )
    ? value.map(text).join("、")
    : value;
}
const types: Record<string, string> = {
  choice: "choice",
  single_choice: "choice",
  multiple_choice: "choice",
  multiplechoice: "choice",
  mcq: "choice",
  single: "choice",
  multiple: "choice",
  选择题: "choice",
  单选题: "choice",
  多选题: "choice",
  truefalse: "truefalse",
  true_false: "truefalse",
  boolean: "truefalse",
  tf: "truefalse",
  判断题: "truefalse",
  判断: "truefalse",
  fill: "fill",
  fill_blank: "fill",
  fill_in_the_blank: "fill",
  fill_in_blank: "fill",
  blank: "fill",
  填空题: "fill",
  calc: "calc",
  calculation: "calc",
  numeric: "calc",
  computation: "calc",
  计算题: "calc",
  short: "short",
  short_answer: "short",
  essay: "short",
  free_response: "short",
  简答题: "short",
  问答题: "short",
  解答题: "short",
};
function question(value: unknown): unknown {
  const q = record(value);
  if (!q) return value;
  const prompt = text(
    field(
      q,
      "prompt",
      "stem",
      "question",
      "questionText",
      "question_text",
      "content",
      "题干",
    ),
  );
  const normalizedOptions = options(
    field(q, "options", "choices", "alternatives", "选项"),
  );
  const rawType = field(q, "type", "questionType", "question_type", "题型");
  const typeKey =
    typeof rawType === "string"
      ? rawType
          .trim()
          .toLowerCase()
          .replace(/[\s/-]+/g, "_")
      : rawType;
  const type =
    typeof typeKey === "string"
      ? (types[typeKey] ?? rawType)
      : rawType == null && typeof prompt === "string"
        ? Array.isArray(normalizedOptions) && normalizedOptions.length >= 2
          ? "choice"
          : normalizeQuestion({ prompt }).type
        : rawType;
  const confidence = field(q, "confidence", "extractionConfidence", "置信度");
  const mappedConfidence =
    typeof confidence === "string"
      ? ((
          {
            high: "high",
            medium: "mid",
            mid: "mid",
            low: "low",
            高: "high",
            中: "mid",
            低: "low",
          } as Record<string, string>
        )[confidence.toLowerCase()] ?? confidence)
      : typeof confidence === "number" && confidence >= 0 && confidence <= 1
        ? confidence >= 0.8
          ? "high"
          : confidence >= 0.5
            ? "mid"
            : "low"
        : (confidence ?? undefined);
  const rawPages = field(
    q,
    "pages",
    "pageNumbers",
    "page_numbers",
    "slidePages",
  );
  const pageList =
    typeof rawPages === "string"
      ? rawPages.split(/[,，\s]+/).filter(Boolean)
      : typeof rawPages === "number"
        ? [rawPages]
        : rawPages;
  const rawKpConfidence = field(
    q,
    "kpConfidence",
    "kp_confidence",
    "knowledgePointConfidence",
  );
  return {
    type,
    prompt,
    options: normalizedOptions,
    answer: answer(
      field(q, "answer", "answers", "correctAnswer", "correct_answer", "答案"),
    ),
    analysis: text(
      field(q, "analysis", "explanation", "solution", "解析") ?? undefined,
    ),
    sourceQuestionId: text(
      field(
        q,
        "sourceQuestionId",
        "source_question_id",
        "questionId",
        "question_id",
        "id",
      ) ?? undefined,
    ),
    kpId: text(
      field(q, "kpId", "kp_id", "knowledgePointId", "knowledge_point_id") ??
        null,
    ),
    kpConfidence:
      typeof rawKpConfidence === "string" &&
      /^\d+(\.\d+)?%$/.test(rawKpConfidence)
        ? Number(rawKpConfidence.slice(0, -1)) / 100
        : number(rawKpConfidence ?? 0),
    pages: Array.isArray(pageList) ? pageList.map(number) : (pageList ?? []),
    sourcePage: number(
      field(q, "sourcePage", "source_page", "page") ?? undefined,
    ),
    confidence: mappedConfidence,
  };
}

/** Only shape/representation changes: invalid or missing essential content still fails Zod. */
export function normalizeQuestionsOutput(value: unknown): unknown {
  for (let depth = 0; depth < 5; depth++) {
    if (Array.isArray(value)) return { questions: value.map(question) };
    const root = record(value);
    if (!root) return value;
    const questions = field(
      root,
      "questions",
      "question_list",
      "questionList",
      "exercises",
      "items",
      "题目",
    );
    if (Array.isArray(questions)) return { questions: questions.map(question) };
    const wrapper = field(
      root,
      "data",
      "result",
      "output",
      "payload",
      "response",
    );
    if (wrapper !== undefined) {
      value = wrapper;
      continue;
    }
    if (field(root, "prompt", "stem", "question", "题干") !== undefined)
      return { questions: [question(root)] };
    return value;
  }
  return value;
}

export function normalizeAnswerOutput(value: unknown): unknown {
  const root = record(value);
  if (!root) return value;
  const q = record(field(root, "data", "result", "output")) ?? root;
  return {
    answer: answer(
      field(q, "answer", "answers", "correctAnswer", "correct_answer", "答案"),
    ),
    analysis: text(field(q, "analysis", "explanation", "solution", "解析")),
  };
}
