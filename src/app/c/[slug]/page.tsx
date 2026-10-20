import { notFound } from "next/navigation";
import { courseContent, getCourseBySlug } from "@/lib/courses";
import { CourseWorkspace } from "@/components/CourseWorkspace";
export const dynamic = "force-dynamic";
export default async function CoursePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const course = getCourseBySlug((await params).slug);
  if (!course) notFound();
  return <CourseWorkspace data={courseContent(course.id)} />;
}
