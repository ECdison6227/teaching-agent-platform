import { notFound } from "next/navigation";
import { courseContent } from "@/lib/courses";
import { ReviewDesk } from "@/components/ReviewDesk";
export const dynamic = "force-dynamic";
export default async function ReviewPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  let data;
  try {
    data = courseContent((await params).courseId);
  } catch {
    notFound();
  }
  return <ReviewDesk initial={data} />;
}
