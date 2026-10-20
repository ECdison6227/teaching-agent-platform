import { enqueueImport } from "@/lib/courses";
import { api } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(
  _: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const { courseId } = await context.params;
  return api(() => enqueueImport(courseId), 201);
}
