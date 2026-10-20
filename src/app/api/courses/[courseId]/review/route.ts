import { api, readJson } from "@/lib/http";
import { reviewContent } from "@/lib/review";
export const runtime = "nodejs";
export async function PATCH(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  return api(async () =>
    reviewContent((await context.params).courseId, await readJson(request)),
  );
}
