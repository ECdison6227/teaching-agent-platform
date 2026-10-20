/** Repair model JSON without inventing values from an unfinished response. */
function repairEscapes(raw: string) {
  let quoted = false;
  let output = "";
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') quoted = !quoted;
    if (quoted && char === "\\") {
      const next = raw[i + 1];
      if (next === "\\" || next === '"' || next === "/") {
        output += char + next;
        i++;
        continue;
      }
      const command = raw.slice(i + 1).match(/^[a-zA-Z]+/)?.[0] || "";
      // These commands begin with otherwise legal JSON control escapes.
      const latex =
        /^(?:b(?:eta|egin|ig|inom|old|ar|ox|race|reve|ullet|f|matrix)|f(?:rac|orall|ootnotesize|box)|n(?:abla|eq|e$|ot|u$|ewcommand|eg|orm|onumber)|r(?:ight|ho|angle|ceil|floor|ef$|m$|oot|aise|ule)|t(?:heta|au|imes|ext|frac|ilde|o$|op$|riangle|ag|anh|iny|hinspace))/.test(
          command,
        );
      const unicode =
        next === "u" && /^[\da-fA-F]{4}/.test(raw.slice(i + 2, i + 6));
      if (!latex && (unicode || (next && "bfnrt".includes(next)))) {
        output += char + next;
        i++;
      } else output += "\\\\";
      continue;
    }
    if (quoted && char.charCodeAt(0) < 32) {
      output += JSON.stringify(char).slice(1, -1);
    } else output += char;
  }
  return output;
}

export function parseModelJson(raw: string): unknown {
  // Search balanced root values: fences and explanatory text stay outside JSON.
  for (let start = 0; start < raw.length; start++) {
    if (raw[start] !== "{" && raw[start] !== "[") continue;
    let quoted = false;
    let escaped = false;
    const stack: string[] = [];
    for (let i = start; i < raw.length; i++) {
      const char = raw[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{" || char === "[") stack.push(char);
      else if (char === "}" || char === "]") {
        if (stack.pop() !== (char === "}" ? "{" : "[")) break;
        if (!stack.length) {
          try {
            return JSON.parse(repairEscapes(raw.slice(start, i + 1)));
          } catch {
            start = i;
            break;
          }
        }
      }
    }
    if (stack.length || quoted) throw new Error("模型 JSON 已截断");
  }
  throw new Error("模型 JSON 无效或已截断");
}
