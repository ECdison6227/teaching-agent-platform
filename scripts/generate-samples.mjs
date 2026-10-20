// 原创示例：手写 PDF 1.4 文本层，无外部图片、字体或课程内容。
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function makePdf(pages) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids = [];
  for (const lines of pages) {
    const pageId = objects.length + 1,
      streamId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
    );
    const escape = (s) => s.replace(/([\\()])/g, "\\$1");
    const stream = `BT /F1 16 Tf 50 730 Td 24 TL ${lines.map((l, i) => `${i ? "T* " : ""}(${escape(l)}) Tj`).join("\n")} ET`;
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(" ")}] >>`;
  let output = "%PDF-1.4\n",
    offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
export function generateSamples(directory = path.resolve("samples")) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "probability.pdf"),
    makePdf([
      [
        "Everyday Probability",
        "An original sample course for the teaching platform.",
        "A probability measures how likely an event is.",
        "Its value lies between 0 and 1.",
      ],
      [
        "Sample Spaces",
        "A sample space lists all possible outcomes.",
        "For one fair coin: S = {heads, tails}.",
        "There are two equally likely outcomes.",
      ],
      [
        "Computing Probability",
        "For equally likely outcomes:",
        "P(event) = favorable outcomes / total outcomes.",
        "A fair six-sided die has P(even) = 3 / 6 = 0.5.",
      ],
      [
        "Independent Events",
        "One independent event does not change the next.",
        "Two fair coin tosses have four equally likely pairs.",
        "P(two heads) = 1 / 4 = 0.25.",
      ],
    ]),
  );
  writeFileSync(
    path.join(directory, "questions.pdf"),
    makePdf([
      [
        "Practice: Everyday Probability",
        "QUESTION 1. What is P(heads) for a fair coin?",
        "A. 0.5",
        "B. 1",
        "Answer: A",
        "QUESTION 2. A probability can be greater than 1. True/False",
        "Answer: F",
        "QUESTION 3. P(even on a fair six-sided die) = ____.",
        "Answer: 0.5",
        "QUESTION 4. Explain independent events using a daily example.",
      ],
    ]),
  );
  return directory;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(`原创 PDF 已生成：${generateSamples()}`);
