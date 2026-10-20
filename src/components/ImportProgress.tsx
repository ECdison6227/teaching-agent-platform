"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CircleCheck, LoaderCircle } from "lucide-react";
import type { Course, Job } from "@/db/schema";
import { appPath } from "@/lib/app-path";
import { Button } from "./ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
  CardFooter,
} from "./ui/card";
export function ImportProgress({
  course,
  initialJob,
}: {
  course: Course;
  initialJob: Job;
}) {
  const [job, setJob] = useState(initialJob),
    [error, setError] = useState("");
  useEffect(() => {
    if (["done", "failed"].includes(job.status)) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(appPath(`/api/jobs/${job.id}`), {
          cache: "no-store",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (!cancelled) {
          setJob(data);
          setError("");
        }
      } catch (e) {
        if (!cancelled)
          setError(`进度连接中断，正在重连：${(e as Error).message}`);
      }
    }
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job.id, job.status]);
  async function retry() {
    try {
      const res = await fetch(appPath(`/api/courses/${course.id}/jobs`), {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setJob(data);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main className="mx-auto max-w-2xl px-5 py-12">
      <Button asChild variant="ghost">
        <Link href="/">
          <ArrowLeft /> 返回课程
        </Link>
      </Button>
      <Card className="mt-8">
        <CardHeader>
          <CardDescription>{course.title}</CardDescription>
          <CardTitle className="flex items-center gap-3 py-3 text-2xl">
            {job.status === "done" ? (
              <CircleCheck className="text-primary" />
            ) : job.status !== "failed" ? (
              <LoaderCircle className="animate-spin text-primary" />
            ) : null}
            {job.status === "done"
              ? "课程已准备好"
              : job.status === "failed"
                ? "本次导入未完成"
                : "正在整理你的课程"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex justify-between text-sm" aria-live="polite">
            <span>{job.step}</span>
            <span>{job.progress}%</span>
          </div>
          <progress
            aria-label="导入进度"
            value={job.progress}
            max={100}
            className="h-3 w-full accent-emerald-700"
          />
          <p className="text-sm leading-7 text-muted-foreground">
            {job.status === "queued"
              ? "资料已保存，等待导入服务领取任务。可离开页面，稍后从首页查看进度。"
              : "任务进度会自动更新。自动整理的内容及答案可以在审核台修订。"}
          </p>
          {job.costTokens > 0 && (
            <p className="text-xs text-muted-foreground">
              已记录模型用量：{job.costTokens} tokens
            </p>
          )}
          {job.error && (
            <p role="alert" className="text-sm text-destructive">
              {job.error}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="gap-3">
          {job.status !== "done" && (
            <Button asChild variant="outline">
              <Link href={`/c/${course.slug}`}>浏览已生成内容</Link>
            </Button>
          )}
          {job.status === "done" && (
            <>
              <Button asChild>
                <Link href={`/c/${course.slug}`}>进入学习空间</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href={`/teach/${course.id}/review`}>审核课程内容</Link>
              </Button>
            </>
          )}
          {job.status === "failed" && (
            <Button onClick={() => void retry()}>从失败处继续</Button>
          )}
        </CardFooter>
      </Card>
    </main>
  );
}
