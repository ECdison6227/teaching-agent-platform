import { eq } from "drizzle-orm";
import { database } from "@/db";
import { jobs } from "@/db/schema";
import { api } from "@/lib/http";
import { getCourse, HttpError } from "@/lib/courses";
export const runtime = "nodejs";
export async function GET(
  _: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  return api(async () => {
    const { jobId } = await context.params;
    const job = database()
      .db.select()
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .get();
    if (!job) throw new HttpError(404, "任务不存在");
    return { ...job, slug: getCourse(job.courseId).slug };
  });
}
