"use client";
import { useState } from "react";
import Link from "next/link";
import type { CourseContent } from "@/lib/courses";
import { appPath } from "@/lib/app-path";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Markdown } from "./Markdown";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "./ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
export function ReviewDesk({ initial }: { initial: CourseContent }) {
  const [data, setData] = useState(initial),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  async function save(body: unknown) {
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch(
        appPath(`/api/courses/${data.course.id}/review`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);
      const updated = await fetch(
        appPath(`/api/courses/${data.course.id}`),
      ).then((r) => r.json());
      setData(updated);
      setNotice("已保存");
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const sortedQuestions = [...data.questions].sort(
    (a, b) => Number(a.verified) - Number(b.verified),
  );
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-5 py-10">
      <header className="flex flex-wrap justify-between gap-4">
        <div>
          <p className="text-sm text-primary">{data.course.title}</p>
          <h1 className="mt-2 text-3xl font-semibold">内容审核台</h1>
        </div>
        <Button asChild variant="outline">
          <Link href={`/c/${data.course.slug}`}>返回学习空间</Link>
        </Button>
      </header>
      <p className="leading-7 text-muted-foreground">
        修改知识点讲义、页面归属和要点，核对题目答案。未核对的题目排在前面。当前为匿名本机模式，持有本机访问权限的使用者均可编辑。
      </p>
      <p
        role="status"
        className="sticky top-0 z-10 bg-background py-2 text-sm text-primary"
      >
        {notice}
      </p>
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">知识点与讲义</h2>
        {data.knowledgePoints.map((k, i) => (
          <Card key={k.id}>
            <CardHeader>
              <CardTitle>
                {k.code} · {k.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                aria-label={`${k.code} 标题`}
                value={k.title}
                onChange={(e) =>
                  setData((p) => ({
                    ...p,
                    knowledgePoints: p.knowledgePoints.map((x, j) =>
                      j === i ? { ...x, title: e.target.value } : x,
                    ),
                  }))
                }
              />
              <Textarea
                aria-label={`${k.code} 讲义`}
                rows={5}
                value={k.contentMd}
                onChange={(e) =>
                  setData((p) => ({
                    ...p,
                    knowledgePoints: p.knowledgePoints.map((x, j) =>
                      j === i ? { ...x, contentMd: e.target.value } : x,
                    ),
                  }))
                }
              />
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void save({
                    kind: "kp",
                    id: k.id,
                    title: k.title,
                    contentMd: k.contentMd,
                  })
                }
              >
                保存知识点
              </Button>
            </CardContent>
          </Card>
        ))}
      </section>
      <section className="space-y-4">
        {data.importItems
          .filter(
            (item) =>
              item.key.startsWith("formulas:") &&
              item.key.includes(":page:") &&
              item.status === "needs_review",
          )
          .map((item) => (
            <p key={item.key} role="alert" className="text-sm text-destructive">
              教材公式缺失 · {item.message}；请核对原始页图后重跑公式恢复。
            </p>
          ))}
        <h2 className="text-xl font-semibold">页面要点与归属</h2>
        {data.pages.map((page, i) => (
          <Card key={page.id}>
            <CardHeader>
              <CardTitle>第 {page.index} 页</CardTitle>
              <CardDescription>
                {page.note?.qaStatus === "passed"
                  ? "要点已通过格式检查"
                  : "要点待核对"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                aria-label={`第 ${page.index} 页标题`}
                value={page.title}
                onChange={(e) =>
                  setData((p) => ({
                    ...p,
                    pages: p.pages.map((x, j) =>
                      j === i ? { ...x, title: e.target.value } : x,
                    ),
                  }))
                }
              />
              <Select
                value={page.kpId || ""}
                onValueChange={(value) =>
                  setData((p) => ({
                    ...p,
                    pages: p.pages.map((x, j) =>
                      j === i ? { ...x, kpId: value } : x,
                    ),
                  }))
                }
              >
                <SelectTrigger aria-label="页面知识点">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.knowledgePoints.map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.code} {k.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Textarea
                aria-label={`第 ${page.index} 页要点`}
                rows={4}
                value={page.note?.points.join("\n") || ""}
                onChange={(e) =>
                  setData((p) => ({
                    ...p,
                    pages: p.pages.map((x, j) =>
                      j === i && x.note
                        ? {
                            ...x,
                            note: {
                              ...x.note,
                              points: e.target.value.split("\n"),
                            },
                          }
                        : x,
                    ),
                  }))
                }
              />
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void save({
                    kind: "page",
                    id: page.id,
                    kpId: page.kpId,
                    title: page.title,
                    points: page.note?.points.filter((p) => p.trim()) || [],
                    keys: page.note?.keys || [],
                  })
                }
              >
                保存页面
              </Button>
            </CardContent>
          </Card>
        ))}
      </section>
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">
          题目与答案（{data.questions.filter((q) => !q.verified).length}{" "}
          道待核对）
        </h2>
        {!sortedQuestions.length && (
          <p className="text-muted-foreground">未上传或未抽取到习题。</p>
        )}
        {sortedQuestions.map((q) => (
          <Card key={q.id} id={`question-${q.id}`} className="scroll-mt-12">
            <CardHeader>
              <CardTitle>
                {q.code} · {q.verified ? "已核对" : "待核对"}
                {!q.kpId && " · 未关联"}
                {q.answerMethod === "consensus" && " · 两轮推导一致"}
                {q.answerMethod === "arbitrated" && " · 仲裁待核对"}
                {q.formulaRecovery?.status === "missing" && " · 公式缺失"}
              </CardTitle>
              {q.formulaRecovery && (
                <p className="text-sm text-muted-foreground">
                  {q.formulaRecovery.status === "missing"
                    ? "公式缺失，需核对原文。"
                    : "公式已恢复，待核对。"}
                  {q.formulaRecovery.evidence.map((item, i) => (
                    <span key={i}>
                      {" "}
                      {item.source} · 置信度 {Math.round(item.confidence * 100)}
                      %
                    </span>
                  ))}
                </p>
              )}
              <Markdown
                text={q.prompt}
                className="text-sm text-muted-foreground"
              />
              {q.options?.map((o) => (
                <Markdown
                  key={o.id}
                  text={`${o.id}. ${o.text}`}
                  className="text-sm"
                />
              ))}
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                aria-label={`${q.code} 答案`}
                placeholder="参考答案；判断题用 T/F"
                value={q.answer || ""}
                onChange={(e) =>
                  setData((p) => ({
                    ...p,
                    questions: p.questions.map((x) =>
                      x.id === q.id ? { ...x, answer: e.target.value } : x,
                    ),
                  }))
                }
              />
              <Textarea
                aria-label={`${q.code} 解析`}
                value={q.analysis || ""}
                placeholder="解析"
                onChange={(e) =>
                  setData((p) => ({
                    ...p,
                    questions: p.questions.map((x) =>
                      x.id === q.id ? { ...x, analysis: e.target.value } : x,
                    ),
                  }))
                }
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || q.formulaRecovery?.status === "missing"}
                  onClick={() =>
                    void save({
                      kind: "question",
                      id: q.id,
                      answer: q.answer,
                      analysis: q.analysis || "",
                      verified: true,
                    })
                  }
                >
                  确认答案已核对
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void save({
                      kind: "question",
                      id: q.id,
                      answer: q.answer,
                      analysis: q.analysis || "",
                      verified: false,
                    })
                  }
                >
                  保存为待核对
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}
