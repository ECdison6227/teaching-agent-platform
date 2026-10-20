import Link from "next/link";
import { ArrowUpRight, BookOpen, Plus, Sparkles } from "lucide-react";
import { listCourses } from "@/lib/courses";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
export const dynamic = "force-dynamic";
export default function Home() {
  const courses = listCourses();
  return (
    <main className="mx-auto max-w-6xl px-6 py-8 sm:py-12">
      <header className="flex items-center justify-between gap-4">
        <Link
          href="/"
          className="flex items-center gap-2 text-lg font-semibold"
        >
          <BookOpen className="size-6 text-primary" /> 学伴{" "}
          <span className="hidden text-sm font-normal text-muted-foreground sm:inline">
            Teaching Agent
          </span>
        </Link>
        <Button asChild>
          <Link href="/new">
            <Plus /> 新建课程
          </Link>
        </Button>
      </header>
      <section className="py-16 sm:py-24">
        <p className="mb-5 flex items-center gap-2 text-sm font-medium text-primary">
          <Sparkles className="size-4" /> 从资料出发，让学习发生
        </p>
        <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          每一门课程，
          <br />
          都有一位耐心的学习伙伴。
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-8 text-muted-foreground">
          上传课件、教材与习题，整理知识脉络。在引导对话中想明白，在自学天地里慢慢学。教师与学生从同一个入口开始。
        </p>
        <Button asChild className="mt-7" size="lg">
          <Link href="/new">
            创建我的第一门课 <ArrowUpRight />
          </Link>
        </Button>
      </section>
      <section aria-label="课程列表">
        <div className="mb-6 flex items-center gap-3">
          <h2 className="text-xl font-semibold">我的课程</h2>
          <span className="text-sm text-muted-foreground">
            {courses.length} 门课程
          </span>
        </div>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {courses.map((c) => (
            <Card key={c.id} className="flex flex-col shadow-sm">
              <CardHeader>
                <CardDescription>
                  {c.subject || "通用课程"} ·{" "}
                  {c.status === "ready" ? "已就绪" : "准备中"}
                </CardDescription>
                <CardTitle className="pt-2 text-xl leading-7">
                  {c.title}
                </CardTitle>
                <CardDescription className="pt-2">
                  {new Date(c.createdAt).toLocaleDateString("zh-CN")} 创建
                </CardDescription>
              </CardHeader>
              <CardFooter className="mt-auto">
                <Button asChild variant="outline" className="w-full">
                  <Link
                    href={
                      c.status === "ready"
                        ? `/c/${c.slug}`
                        : `/teach/${c.id}/import`
                    }
                  >
                    {c.status === "ready" ? "进入学习空间" : "查看导入进度"}
                    <ArrowUpRight />
                  </Link>
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
        {!courses.length && (
          <Card className="border-dashed shadow-none">
            <CardHeader className="items-center py-12 text-center">
              <BookOpen className="mb-2 size-8 text-primary" />
              <CardTitle>你的课程空间，正在等你</CardTitle>
              <CardDescription>
                准备一份 PPT 或教材 PDF，就可以开始。
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </section>
      <footer className="mt-16 border-t pt-6 text-xs leading-6 text-muted-foreground">
        本机课程空间 · 匿名使用 · 上传资料的版权由使用方负责
      </footer>
    </main>
  );
}
