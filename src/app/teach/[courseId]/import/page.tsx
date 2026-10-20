import { notFound } from "next/navigation";
import { courseContent } from "@/lib/courses";
import { CourseWizard } from "@/components/CourseWizard";
import { ImportProgress } from "@/components/ImportProgress";
export const dynamic = "force-dynamic";
export default async function ImportPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  let data;
  try {
    data = courseContent(courseId);
  } catch {
    notFound();
  }
  if (!data.jobs.length)
    return <CourseWizard initial={{ ...data.course, sources: data.sources }} />;
  return <ImportProgress course={data.course} initialJob={data.jobs[0]} />;
}
