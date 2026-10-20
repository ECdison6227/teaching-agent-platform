import { createCourse, listCourses } from "@/lib/courses";
import { api, readJson } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  return api(() => ({ courses: listCourses() }));
}
export async function POST(request: Request) {
  return api(async () => createCourse(await readJson(request)), 201);
}
