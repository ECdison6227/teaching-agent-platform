import { DOMParser, type Element } from "@xmldom/xmldom";
import katex from "katex";
import { missingFormula, latexFormulas } from "./formulas";
import { questionBoundaries } from "./question-parser";

const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const mathNamespace = (ns: string | null) =>
  ns === M || ns === "http://purl.oclc.org/ooxml/officeDocument/math";
const wordNamespace = (ns: string | null) =>
  ns === W || ns === "http://purl.oclc.org/ooxml/wordprocessingml/main";
const children = (e: Element) =>
  Array.from(e.childNodes).filter((n): n is Element => n.nodeType === 1);
const child = (e: Element, name: string) =>
  children(e).find((n) => n.localName === name);
const property = (e: Element, group: string, name: string) => {
  const p = child(e, group),
    value = p && child(p, name);
  return value?.getAttributeNS(value.namespaceURI, "val") || undefined;
};
function parse(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("不支持带 DTD 的文档 XML");
  return new DOMParser({
    onError: (level) => {
      if (level !== "warning") throw new Error("文档 XML 格式无效");
    },
  }).parseFromString(xml, "application/xml");
}
const symbols: Record<string, string> = {
  α: "\\alpha ",
  β: "\\beta ",
  γ: "\\gamma ",
  δ: "\\delta ",
  ε: "\\epsilon ",
  θ: "\\theta ",
  λ: "\\lambda ",
  μ: "\\mu ",
  π: "\\pi ",
  ρ: "\\rho ",
  σ: "\\sigma ",
  τ: "\\tau ",
  φ: "\\phi ",
  ω: "\\omega ",
  Δ: "\\Delta ",
  Σ: "\\Sigma ",
  Ω: "\\Omega ",
  "≤": "\\le ",
  "≥": "\\ge ",
  "≠": "\\ne ",
  "×": "\\times ",
  "÷": "\\div ",
  "∞": "\\infty ",
  "∈": "\\in ",
  "∉": "\\notin ",
  "±": "\\pm ",
  "−": "-",
  "⋅": "\\cdot ",
  "∂": "\\partial ",
  "∇": "\\nabla ",
  "→": "\\to ",
  "≈": "\\approx ",
};
const escapeMath = (text: string) =>
  [...text]
    .map(
      (c) =>
        symbols[c] ||
        {
          "{": "\\{",
          "}": "\\}",
          "%": "\\%",
          "#": "\\#",
          "&": "\\&",
          $: "\\$",
          "\\": "\\backslash ",
        }[c] ||
        c,
    )
    .join("");
/** Conservative OMML subset. Unknown objects fail closed and use the page image. */
function convert(e: Element): string {
  if (!mathNamespace(e.namespaceURI)) {
    if (wordNamespace(e.namespaceURI) && e.localName === "rPr") return "";
    throw new Error("未知公式节点");
  }
  const all = () => children(e).map(convert).join("");
  const part = (name: string) => {
    const n = child(e, name);
    if (!n) throw new Error("公式参数缺失");
    return convert(n);
  };
  const script = (name: string) => {
    const n = child(e, name);
    return n ? convert(n) : "";
  };
  switch (e.localName) {
    case "t":
      return escapeMath(e.textContent || "");
    case "oMath":
    case "oMathPara":
    case "r":
    case "e":
    case "num":
    case "den":
    case "sub":
    case "sup":
    case "deg":
    case "lim":
    case "fName":
      return all();
    case "f": {
      const type = property(e, "fPr", "type");
      if (type && type !== "bar") throw new Error("不支持的分式样式");
      return `\\frac{${part("num")}}{${part("den")}}`;
    }
    case "sSup":
      return `{${part("e")}}^{${part("sup")}}`;
    case "sSub":
      return `{${part("e")}}_{${part("sub")}}`;
    case "sSubSup":
      return `{${part("e")}}_{${part("sub")}}^{${part("sup")}}`;
    case "rad":
      return `\\sqrt${property(e, "radPr", "degHide") === "1" || !script("deg") ? "" : `[${script("deg")}]`}{${part("e")}}`;
    case "d": {
      const delimiter = (value: string) =>
        ({ "{": "\\{", "}": "\\}", "": "." })[value] ?? value;
      const begin = property(e, "dPr", "begChr") ?? "(",
        end = property(e, "dPr", "endChr") ?? ")";
      return `\\left${delimiter(begin)}${children(e)
        .filter((c) => c.localName === "e")
        .map(convert)
        .join(property(e, "dPr", "sepChr") ?? "|")}\\right${delimiter(end)}`;
    }
    case "nary": {
      const operator = {
        "∑": "\\sum",
        "∏": "\\prod",
        "∫": "\\int",
        "∬": "\\iint",
        "∮": "\\oint",
      }[property(e, "naryPr", "chr") || "∫"];
      if (!operator) throw new Error("未知运算符");
      return `${operator}${property(e, "naryPr", "subHide") === "1" || !script("sub") ? "" : `_{${script("sub")}}`}${property(e, "naryPr", "supHide") === "1" || !script("sup") ? "" : `^{${script("sup")}}`} ${part("e")}`;
    }
    case "func":
      return `\\operatorname{${part("fName")}} ${part("e")}`;
    case "limLow":
      return `{${part("e")}}_{${part("lim")}}`;
    case "limUpp":
      return `{${part("e")}}^{${part("lim")}}`;
    case "bar":
      return `\\${property(e, "barPr", "pos") === "bot" ? "underline" : "overline"}{${part("e")}}`;
    case "acc": {
      const accent = {
        "̂": "hat",
        "̅": "bar",
        "⃗": "vec",
        "̇": "dot",
        "̈": "ddot",
        "̃": "tilde",
      }[property(e, "accPr", "chr") || "̂"];
      if (!accent) throw new Error("未知重音");
      return `\\${accent}{${part("e")}}`;
    }
    case "m":
      return `\\begin{matrix}${children(e)
        .filter((c) => c.localName === "mr")
        .map((row) =>
          children(row)
            .filter((c) => c.localName === "e")
            .map(convert)
            .join(" & "),
        )
        .join(" \\\\ ")}\\end{matrix}`;
    case "eqArr":
      return `\\begin{gathered}${children(e)
        .filter((c) => c.localName === "e")
        .map(convert)
        .join(" \\\\ ")}\\end{gathered}`;
    case "box":
      return part("e");
    default:
      if (e.localName?.endsWith("Pr")) return "";
      throw new Error("不支持的 OMML 对象");
  }
}
export function validLatex(text: string) {
  try {
    const formulas = latexFormulas(text);
    if (!formulas.length) return false;
    for (const formula of formulas)
      katex.renderToString(formula, {
        throwOnError: true,
        strict: "error",
        trust: false,
      });
    return true;
  } catch {
    return false;
  }
}
export function ommlToLatex(xml: string) {
  const root = parse(xml).documentElement;
  if (!root) throw new Error("公式 XML 为空");
  const result = convert(root).trim();
  if (!validLatex(`$${result}$`)) throw new Error("OMML 无法转换为有效 LaTeX");
  return result;
}
export type MathParagraph = {
  text: string;
  latex: string[];
  unresolved: boolean;
  questionId?: string;
};
export function docxMathParagraphs(xml: string): MathParagraph[] {
  const doc = parse(xml);
  const paragraphs = Array.from(doc.getElementsByTagName("*")).filter(
    (n) => wordNamespace(n.namespaceURI) && n.localName === "p",
  );
  const rows = paragraphs.map((p) => {
    const latex: string[] = [];
    let unresolved = false;
    function walk(e: Element): string {
      if (mathNamespace(e.namespaceURI) && e.localName === "oMath") {
        try {
          const value = convert(e).trim();
          if (!validLatex(`$${value}$`)) throw new Error("无效公式");
          latex.push(value);
          return `$${value}$`;
        } catch {
          unresolved = true;
          return missingFormula;
        }
      }
      if (e.localName === "object" || e.localName === "OLEObject") {
        unresolved = true;
        return missingFormula;
      }
      if (wordNamespace(e.namespaceURI)) {
        if (e.localName === "t") return e.textContent || "";
        if (e.localName === "tab") return "\t";
        if (e.localName === "br") return "\n";
        if (["del", "pPr", "rPr"].includes(e.localName || "")) return "";
      }
      return children(e).map(walk).join("");
    }
    const text = walk(p);
    return { text, latex, unresolved };
  });
  // Include the question's prose around formula-only option paragraphs, so A/B
  // formulas are never matched to another question merely by their option ID.
  const grouped = questionBoundaries([
    { text: rows.map((p) => p.text).join("\n") },
  ])
    .filter(
      (q) =>
        q.numbered &&
        (latexFormulas(q.text).length || q.text.includes(missingFormula)),
    )
    .map((q) => ({
      text: q.text,
      latex: latexFormulas(q.text),
      unresolved: q.text.includes(missingFormula),
      questionId: q.id,
    }));
  return [
    ...grouped,
    ...rows.filter(
      (p) =>
        (p.latex.length || p.unresolved) &&
        !grouped.some((g) => g.text.includes(p.text)),
    ),
  ];
}
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Match surrounding prose, permitting PDF line wrapping and omitted/mangled math. */
export function applyOmml(
  text: string,
  paragraphs: MathParagraph[],
  questionId?: string,
) {
  const evidence: string[] = [];
  let unresolved = false;
  for (const paragraph of paragraphs) {
    if (
      questionId &&
      paragraph.questionId &&
      paragraph.questionId !== questionId
    )
      continue;
    const parts = paragraph.text.split(/\$[^$\n]+\$|\[公式缺失\]/);
    if (parts.join("").replace(/\s/g, "").length < 8) continue;
    if (!parts[0].trim()) continue;
    const pattern =
      (paragraph.questionId ? "(?<![0-9０-９])" : "") +
      parts
        .map((s) => [...s.replace(/\s/g, "")].map(escapeRegex).join("\\s*"))
        .join("[\\s\\S]{0,2000}?") +
      (!parts.at(-1)!.trim() ? "(?=\\n|$)" : "");
    const matches = [...text.matchAll(new RegExp(pattern, "g"))];
    if (matches.length !== 1) continue;
    const match = matches[0];
    text =
      text.slice(0, match.index) +
      paragraph.text +
      text.slice(match.index! + match[0].length);
    evidence.push(...paragraph.latex);
    unresolved ||= paragraph.unresolved;
  }
  return { text, latex: [...new Set(evidence)], unresolved };
}
