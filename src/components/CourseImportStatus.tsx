"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { CourseContent } from "@/lib/courses";
import { appPath } from "@/lib/app-path";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";

export function CourseImportStatus({ data }: { data: CourseContent }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const job = data.jobs[0];
  const active = job && ["queued", "running"].includes(job.status);
  const failed = job?.status === "failed" || data.course.status === "failed";
  const pending = data.importItems.filter(
    (item) => item.status === "needs_review",
  );
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
  if (data.course.status === "ready" && !active && !pending.length) return null;
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
        {pending.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {pending.map((item) => item.message).join("；")}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {failed && (
            <Button size="sm" disabled={busy} onClick={() => void resume()}>
              从失败处继续
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
