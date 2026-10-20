import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const courses = sqliteTable("courses", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  subject: text("subject").notNull().default(""),
  institution: text("institution"),
  logoAssetId: text("logo_asset_id"),
  language: text("language").notNull().default("zh"),
  ownerId: text("owner_id").notNull().default("anonymous"),
  visibility: text("visibility", { enum: ["private", "class", "public"] })
    .notNull()
    .default("private"),
  status: text("status", { enum: ["draft", "ready"] })
    .notNull()
    .default("draft"),
  persona: text("persona"),
  createdAt: text("created_at").notNull(),
});
export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["slides", "textbook", "question_bank", "material"],
    }).notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    sha256: text("sha256").notNull(),
    pages: integer("pages").notNull().default(0),
    storageKey: text("storage_key").notNull(),
    pdfKey: text("pdf_key"),
    textKey: text("text_key"),
    uploadedBy: text("uploaded_by").notNull().default("anonymous"),
    status: text("status", {
      enum: ["uploaded", "processing", "ready", "failed"],
    })
      .notNull()
      .default("uploaded"),
  },
  (t) => [uniqueIndex("source_dedup").on(t.courseId, t.kind, t.sha256)],
);
export const chapters = sqliteTable("chapters", {
  id: text("id").primaryKey(),
  courseId: text("course_id")
    .notNull()
    .references(() => courses.id, { onDelete: "cascade" }),
  order: integer("order").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
});
export const knowledgePoints = sqliteTable(
  "knowledge_points",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    title: text("title").notNull(),
    order: integer("order").notNull(),
    contentMd: text("content_md").notNull().default(""),
    keywords: text("keywords", { mode: "json" }).$type<string[]>().notNull(),
    hasSlides: integer("has_slides", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => [uniqueIndex("kp_course_code").on(t.courseId, t.code)],
);
export const pages = sqliteTable(
  "pages",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    sourcePage: integer("source_page").notNull(),
    imageKey: text("image_key").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    rawText: text("raw_text").notNull(),
    title: text("title").notNull(),
    kpId: text("kp_id").references(() => knowledgePoints.id, {
      onDelete: "set null",
    }),
    elements: text("elements", { mode: "json" }).$type<unknown[]>(),
  },
  (t) => [uniqueIndex("course_page").on(t.courseId, t.index)],
);
export const pageNotes = sqliteTable("page_notes", {
  pageId: text("page_id")
    .primaryKey()
    .references(() => pages.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  points: text("points", { mode: "json" }).$type<string[]>().notNull(),
  keys: text("keys", { mode: "json" }).$type<string[]>().notNull(),
  model: text("model").notNull(),
  version: integer("version").notNull().default(1),
  qaStatus: text("qa_status", { enum: ["passed", "needs_review"] }).notNull(),
});
export const questions = sqliteTable(
  "questions",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    type: text("type", {
      enum: ["choice", "truefalse", "fill", "calc", "short"],
    }).notNull(),
    prompt: text("prompt").notNull(),
    options: text("options", { mode: "json" }).$type<
      { id: string; text: string }[]
    >(),
    answer: text("answer"),
    analysis: text("analysis"),
    kpId: text("kp_id")
      .notNull()
      .references(() => knowledgePoints.id, { onDelete: "cascade" }),
    pageIds: text("page_ids", { mode: "json" }).$type<string[]>().notNull(),
    source: text("source", { mode: "json" })
      .$type<{ sourceId: string; page?: number } | "generated">()
      .notNull(),
    confidence: text("confidence", { enum: ["high", "mid", "low"] }).notNull(),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    reviewStatus: text("review_status", {
      enum: ["auto", "needs_review", "teacher_ok"],
    })
      .notNull()
      .default("needs_review"),
  },
  (t) => [uniqueIndex("question_course_code").on(t.courseId, t.code)],
);
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("import"),
    status: text("status", { enum: ["queued", "running", "done", "failed"] })
      .notNull()
      .default("queued"),
    progress: integer("progress").notNull().default(0),
    step: text("step").notNull().default("等待 worker"),
    error: text("error"),
    costTokens: integer("cost_tokens").notNull().default(0),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    heartbeatAt: text("heartbeat_at"),
  },
  (t) => [index("job_queue").on(t.status, t.createdAt)],
);

export type Course = typeof courses.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type Page = typeof pages.$inferSelect;
export type KnowledgePoint = typeof knowledgePoints.$inferSelect;
export type Question = typeof questions.$inferSelect;
export type Job = typeof jobs.$inferSelect;
