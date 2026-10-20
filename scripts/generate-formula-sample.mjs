// Original, subject-independent OMML sample. Generated DOCX files stay in DATA_DIR.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [filename, text] of Object.entries(entries)) {
    const name = Buffer.from(filename),
      bytes = Buffer.from(text),
      crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    local.push(header, name, bytes);
    central.push(record, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export const fractionOmml = `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:f><m:num><m:r><m:t>x+1</m:t></m:r></m:num><m:den><m:r><m:t>3</m:t></m:r></m:den></m:f></m:oMath>`;
const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (text) => `<w:p>${run(text)}</w:p>`;
export function makeFormulaDocx({ gaps = false, textbook = false } = {}) {
  const body = gaps
    ? [
        paragraph("Original symbolic comparison"),
        paragraph("1. If ____ is positive, choose a matching expression. ( )"),
        paragraph("A. "),
        paragraph("B. zero"),
      ].join("")
    : [
        paragraph("Original symbolic comparison"),
        `<w:p>${run(textbook ? "The expression " : "1. If ")}${fractionOmml}${run(textbook ? " is positive when its numerator is positive." : " is positive, which expression is shown? ( )")}</w:p>`,
        ...(!textbook
          ? [
              `<w:p>${run("A. ")}<m:oMath><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></w:p>`,
              `<w:p>${run("B. ")}<m:oMath><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad></m:oMath></w:p>`,
              paragraph("Answer: A"),
            ]
          : []),
      ].join("");
  return zip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  });
}
export async function generateFormulaSamples(directory) {
  await mkdir(directory, { recursive: true });
  for (const [name, options] of [
    ["omml-questions.docx", {}],
    ["missing-formulas.docx", { gaps: true }],
    ["omml-textbook.docx", { textbook: true }],
  ])
    await writeFile(path.join(directory, name), makeFormulaDocx(options));
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const directory = path.resolve(
    process.env.DATA_DIR || "data",
    "samples/formulas",
  );
  await generateFormulaSamples(directory);
  console.log(`原创 OMML 样例：${directory}`);
}
