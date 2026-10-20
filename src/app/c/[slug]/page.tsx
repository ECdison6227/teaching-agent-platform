import Link from "next/link";
import { notFound } from "next/navigation";
import { courseContent, getCourseBySlug } from "@/lib/courses";
import { CourseWorkspace } from "@/components/CourseWorkspace";
import { Button } from "@/components/ui/button";
export const dynamic = "force-dynamic";
export default async function CoursePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const course = getCourseBySlug((await params).slug);
  if (!course) notFound();
  if (course.status !== "ready")
    return (
      <main className="mx-auto max-w-xl space-y-6 p-10">
        <h1 className="text-2xl">{course.title}</h1>
        <p>课程正在准备中。</p>
        <Button asChild>
          <Link href={`/teach/${course.id}/import`}>查看导入进度</Link>
        </Button>
      </main>
    );
  return <CourseWorkspace data={courseContent(course.id)} />;
}
