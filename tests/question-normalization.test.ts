import test from "node:test";
import assert from "node:assert/strict";
import {
  QuestionsSchema,
  QuestionAnswerSchema,
} from "../src/lib/import-schemas";
import {
  normalizeQuestionsOutput,
  normalizeAnswerOutput,
} from "../src/lib/question-normalization";
import { importNotices } from "../src/lib/import-notices";

test("非选择题 options=[] 单独触发旧 schema 的 too_small，归一化后保留题干与类型", () => {
  for (const type of ["truefalse", "fill", "calc", "short"]) {
    const output = {
      questions: [
        { type, prompt: "解释一个原创概念。", options: [], answer: null },
      ],
    };
    const original = QuestionsSchema.safeParse(output);
    assert.equal(original.success, false);
    if (!original.success)
      assert.ok(
        original.error.issues.some(
          (issue) =>
            issue.path.join(".") === "questions.0.options" &&
            issue.code === "too_small",
        ),
      );
    const q = QuestionsSchema.parse(normalizeQuestionsOutput(output))
      .questions[0];
    assert.equal(q.type, type);
    assert.equal(q.prompt, output.questions[0].prompt);
    assert.equal(q.options, undefined);
    assert.equal(q.answer, null);
  }
});

test("模型习题字段别名、包裹层、字符串选项、对象选项与标量强制归一化", () => {
  for (const choices of [
    ["A. 一个", "B．两个"],
    { A: "一个", B: "两个" },
    [
      { key: "A", content: "一个" },
      { label: "B", value: "两个" },
    ],
  ]) {
    const output = normalizeQuestionsOutput({
      data: {
        result: {
          exercises: [
            {
              question_id: 7,
              question_type: "multiple-choice",
              stem: "选择数量。",
              choices,
              correct_answer: ["A"],
              explanation: null,
              kp_id: null,
              kp_confidence: "85%",
              page_numbers: ["2", "3"],
              source_page: "2",
              confidence: "medium",
            },
          ],
        },
      },
    });
    const q = QuestionsSchema.parse(output).questions[0];
    assert.equal(q.sourceQuestionId, "7");
    assert.equal(q.type, "choice");
    assert.equal(q.answer, "A");
    assert.deepEqual(q.options, [
      { id: "A", text: "一个" },
      { id: "B", text: "两个" },
    ]);
    assert.deepEqual(q.pages, [2, 3]);
    assert.equal(q.sourcePage, 2);
    assert.equal(q.kpConfidence, 0.85);
    assert.equal(q.confidence, "mid");
  }
});

test("类型映射、缺可选字段、空选项与答案数组；未知类型和缺题干仍拒绝", () => {
  for (const [type, expected] of [
    ["判断题", "truefalse"],
    ["fill-in-the-blank", "fill"],
    ["calculation", "calc"],
    ["short_answer", "short"],
  ]) {
    const q = QuestionsSchema.parse(
      normalizeQuestionsOutput([
        { type, prompt: "一个问题", options: [], answer: [2, 3] },
      ]),
    ).questions[0];
    assert.equal(q.type, expected);
    assert.equal(q.answer, "2、3");
    assert.equal(q.options, undefined);
  }
  const q = QuestionsSchema.parse(
    normalizeQuestionsOutput({ question: "计算 2+3。", options: null }),
  ).questions[0];
  assert.equal(q.type, "calc");
  assert.deepEqual(q.pages, []);
  for (const invalid of [
    [{ type: "made_up", prompt: "问题" }],
    [{ type: "calc" }],
    [{ prompt: "问题", options: [null, "B"] }],
    [{ prompt: "问题", pages: ["unknown"] }],
  ])
    assert.equal(
      QuestionsSchema.safeParse(normalizeQuestionsOutput(invalid)).success,
      false,
    );
});

test("答案推导接受数组/数值/布尔别名，保留 null，缺少依据仍拒绝", () => {
  for (const [answer, expected] of [
    [["A"], "A"],
    [6, "6"],
    [false, "false"],
    [null, null],
  ] as const) {
    const result = QuestionAnswerSchema.parse(
      normalizeAnswerOutput({
        result: { correct_answer: answer, explanation: "按定义核对。" },
      }),
    );
    assert.equal(result.answer, expected);
  }
  assert.equal(
    QuestionAnswerSchema.safeParse(normalizeAnswerOutput({ answer: 6 }))
      .success,
    false,
  );
});

test("顶部提示按类型计数，限流和答案待补分开，已补答案隐藏旧标记", () => {
  const notices = importNotices({
    importItems: [
      ...Array.from({ length: 7 }, (_, i) => ({
        courseId: "c",
        key: `questions:${i}`,
        status: "needs_review" as const,
        message: "该批习题使用规则抽取，待核对",
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        courseId: "c",
        key: `answers:${i}`,
        status: "needs_review" as const,
        message: "答案未能可靠推导",
      })),
      {
        courseId: "c",
        key: "answers:rate",
        status: "pending" as const,
        message: "上游限流",
      },
      {
        courseId: "c",
        key: "answers:done",
        status: "done" as const,
        message: null,
      },
    ].reverse(),
    questions: [],
  });
  assert.equal(
    notices.map((n) => n.summary).join(" · "),
    "7 批习题使用规则抽取 · 6 题答案待补 · 1 题答案因限流待处理",
  );
  assert.equal(notices[0].items.length, 7);
});
