"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { CourseContent } from "@/lib/courses";
import { appPath } from "@/lib/app-path";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { ChevronDown, ChevronUp } from "lucide-react";
import { importNotices } from "@/lib/import-notices";

export function CourseImportStatus({ data }: { data: CourseContent }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const job = data.jobs[0];
  const active = job && ["queued", "running"].includes(job.status);
  const failed = job?.status === "failed" || data.course.status === "failed";
  const notices = importNotices(data);
  const deferred = notices.some((group) => group.type === "rate_limit");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [active, router]);
  async function resume() {
    setBusy(true);
    try {
      const res = await fetch(appPath(`/api/courses/${data.course.id}/jobs`), {
        method: "POST",
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);
      setError("");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (data.course.status === "ready" && !active && !notices.length) return null;
  return (
    <Card className="mx-4 mt-4 shadow-none sm:mx-8">
      <CardContent className="space-y-3 p-4">
        <p role={failed ? "alert" : "status"} className="text-sm">
          {failed
            ? `导入未完成：${job?.error || "请从失败处继续"}`
            : active
              ? `导入进度 ${job.progress}% · ${job.step}`
              : data.course.status === "ready"
                ? "课程已整理，部分内容待核对。"
                : "课程正在整理，已生成内容可先浏览。"}
        </p>
        {active && (
          <progress
            aria-label="课程导入进度"
            value={job.progress}
            max={100}
            className="h-2 w-full accent-emerald-700"
          />
        )}
        {notices.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {notices.map((group) => group.summary).join(" · ")}
          </p>
        )}
        {notices.length > 0 && (
          <div>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={expanded}
              aria-controls="import-notice-details"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <ChevronUp /> : <ChevronDown />}{" "}
              {expanded ? "收起明细" : "展开明细"}
            </Button>
            {expanded && (
              <div
                id="import-notice-details"
                className="max-h-64 space-y-3 overflow-y-auto py-2 text-sm"
              >
                {notices.map((group) => (
                  <div key={group.label}>
                    <p className="font-medium">{group.summary}</p>
                    <ul className="list-inside list-disc text-muted-foreground">
                      {group.items.map((item) => (
                        <li key={item.key}>
                          {item.message}{" "}
                          <Link
                            className="underline"
                            href={`/teach/${data.course.id}/review${item.questionId ? `#question-${item.questionId}` : ""}`}
                          >
                            前往审核
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {(failed || deferred) && !active && (
            <Button size="sm" disabled={busy} onClick={() => void resume()}>
              {failed ? "从失败处继续" : "续跑待处理答案"}
            </Button>
          )}
          {notices.length > 0 && (
            <Button asChild size="sm" variant="outline">
              <Link href={`/teach/${data.course.id}/review`}>打开审核台</Link>
            </Button>
          )}
          <Button asChild size="sm" variant="outline">
            <Link href={`/teach/${data.course.id}/import`}>查看导入进度</Link>
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
