"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, FileUp, LoaderCircle } from "lucide-react";
import { Button } from "./ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./ui/card";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { appPath } from "@/lib/app-path";
const steps = ["创建课程", "课程 PPT", "教材", "习题", "其他资料"];
const kinds = ["", "slides", "textbook", "question_bank", "material"];
async function jsonRequest(url: string, init: RequestInit) {
  const response = await fetch(appPath(url), init),
    body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}
export function CourseWizard({
  initial,
}: {
  initial?: {
    id: string;
    title: string;
    subject: string;
    persona: string | null;
    sources: { kind: string; filename: string }[];
  };
}) {
  const router = useRouter();
  const [step, setStep] = useState(initial ? 1 : 0),
    [courseId, setCourseId] = useState<string | null>(initial?.id || null);
  const [title, setTitle] = useState(initial?.title || ""),
    [subject, setSubject] = useState(initial?.subject || ""),
    [persona, setPersona] = useState(initial?.persona || "");
  const [files, setFiles] = useState<File[]>([]),
    [uploaded, setUploaded] = useState<Record<string, string[]>>(() =>
      Object.fromEntries(
        kinds.map((k) => [
          k,
          initial?.sources.filter((s) => s.kind === k).map((s) => s.filename) ||
            [],
        ]),
      ),
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function next(skip = false) {
    setBusy(true);
    setError("");
    try {
      if (step === 0) {
        if (!courseId) {
          const course = await jsonRequest("/api/courses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title:
                title.trim() ||
                `新课程 ${new Date().toLocaleDateString("zh-CN")}`,
              subject,
              persona,
            }),
          });
          setCourseId(course.id);
        }
      } else if (!skip && files.length) {
        for (const file of files) {
          const form = new FormData();
          form.set("kind", kinds[step]);
          form.set("file", file);
          await jsonRequest(`/api/courses/${courseId}/sources`, {
            method: "POST",
            body: form,
          });
          setUploaded((prev) => ({
            ...prev,
            [kinds[step]]: [
              ...new Set([...(prev[kinds[step]] || []), file.name]),
            ],
          }));
        }
      }
      setFiles([]);
      if (step === 4) {
        await jsonRequest(`/api/courses/${courseId}/jobs`, { method: "POST" });
        router.push(`/teach/${courseId}/import`);
      } else setStep(step + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-4xl px-5 py-10">
      <Button asChild variant="ghost">
        <Link href="/">
          <ArrowLeft /> 返回课程
        </Link>
      </Button>
      <p className="mt-10 text-sm text-primary">建立你的学习空间</p>
      <h1 className="mt-3 text-3xl font-semibold">把课程资料交给学伴</h1>
      <p className="mt-4 leading-7 text-muted-foreground">
        五个小步骤，教师和学生都能创建。资料步骤可跳过，至少提供一份课件或教材。
      </p>
      <ol className="my-8 grid grid-cols-5 gap-2" aria-label="建课步骤">
        {steps.map((s, i) => (
          <li
            key={s}
            aria-current={step === i ? "step" : undefined}
            className={`border-t-2 pt-3 text-xs sm:text-sm ${i <= step ? "border-primary text-primary" : "text-muted-foreground"}`}
          >
            <span className="mb-1 block text-lg">
              {i < step ? <Check className="size-5" /> : `0${i + 1}`}
            </span>
            {s}
          </li>
        ))}
      </ol>
      <Card>
        <CardHeader>
          <CardTitle>{steps[step]}</CardTitle>
          <CardDescription>
            {step === 0
              ? "课程名称可自定；跳过时将使用默认名称。"
              : "支持 PDF、PPT/PPTX、DOC/DOCX、ODP；每个文件不超过 200 MB，最多 12 份资料。"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {step === 0 ? (
            <>
              <label className="block space-y-2">
                <span className="text-sm">课程名称</span>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={120}
                  disabled={!!courseId}
                  placeholder="例如：概率与日常决策"
                />
              </label>
              <label className="block space-y-2">
                <span className="text-sm">学科（可选）</span>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  disabled={!!courseId}
                  maxLength={100}
                  placeholder="例如：数学"
                />
              </label>
              <label className="block space-y-2">
                <span className="text-sm">助教风格（可选）</span>
                <Textarea
                  value={persona}
                  onChange={(e) => setPersona(e.target.value)}
                  disabled={!!courseId}
                  maxLength={2000}
                  placeholder="例如：先给生活中的例子，再引导我推导公式。"
                />
              </label>
            </>
          ) : (
            <>
              <div className="rounded-lg border border-dashed bg-muted/40 p-8">
                <FileUp className="mb-4 size-7 text-primary" />
                <label className="block space-y-3">
                  <span className="block font-medium">
                    添加{steps[step]}文件
                  </span>
                  <Input
                    key={step}
                    type="file"
                    multiple
                    accept=".pdf,.ppt,.pptx,.doc,.docx,.odp"
                    disabled={busy}
                    onChange={(e) => setFiles(Array.from(e.target.files || []))}
                    className="h-auto py-3"
                  />
                </label>
                <p className="mt-3 text-xs leading-6 text-muted-foreground">
                  请确认你有权使用这些资料。原文件存储在本机课程目录。
                </p>
              </div>
              {files.length > 0 && (
                <p className="text-sm">
                  已选择：{files.map((f) => f.name).join("、")}
                </p>
              )}
              {uploaded[kinds[step]]?.map((f) => (
                <p key={f} className="text-sm text-primary">
                  ✓ 已上传 {f}
                </p>
              ))}
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-between gap-3">
          <Button
            variant="ghost"
            disabled={step === 0 || busy}
            onClick={() => {
              setFiles([]);
              setError("");
              setStep(step - 1);
            }}
          >
            上一步
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void next(true)}
            >
              {step === 4 ? "跳过并开始导入" : "跳过"}
            </Button>
            <Button disabled={busy} onClick={() => void next()}>
              {busy && <LoaderCircle className="animate-spin" />}
              {step === 4 ? "开始导入" : "下一步"}
            </Button>
          </div>
        </CardFooter>
      </Card>
      {courseId && (
        <p className="mt-5 text-sm text-muted-foreground">
          资料会随上传保存。
          <Link
            href={`/teach/${courseId}/import`}
            className="text-primary underline"
          >
            离开向导后可在进度页继续
          </Link>
        </p>
      )}
    </main>
  );
}
