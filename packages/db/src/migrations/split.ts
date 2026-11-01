/**
 * Splits a SQL script into statements for drivers that only speak the extended protocol
 * (one statement per query). Understands `--` and block comments, quoted strings and
 * identifiers, and dollar-quoted bodies (`$$ ... $$`, `$tag$ ... $tag$`) used by functions.
 */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  const n = script.length;

  while (i < n) {
    const ch = script[i];
    const next = script[i + 1];
    if (ch === "-" && next === "-") {
      const end = script.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
    } else if (ch === "/" && next === "*") {
      const end = script.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated block comment");
      i = end + 2;
    } else if (ch === "'" || ch === '"') {
      i = skipQuoted(script, i, ch);
    } else if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(script.slice(i))?.[0];
      if (tag) {
        const end = script.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error(`unterminated dollar quote ${tag}`);
        i = end + tag.length;
      } else {
        i++;
      }
    } else if (ch === ";") {
      push(statements, script.slice(start, i));
      start = ++i;
    } else {
      i++;
    }
  }
  push(statements, script.slice(start));
  return statements;
}

function skipQuoted(script: string, from: number, quote: string): number {
  let i = from + 1;
  for (;;) {
    const end = script.indexOf(quote, i);
    if (end === -1) throw new Error(`unterminated ${quote === "'" ? "string" : "identifier"}`);
    // A doubled quote is an escaped quote inside the literal.
    if (script[end + 1] === quote) {
      i = end + 2;
      continue;
    }
    return end + 1;
  }
}

function push(statements: string[], raw: string): void {
  const withoutComments = raw.replace(/--[^\n]*/g, "").trim();
  if (withoutComments.length > 0) statements.push(raw.trim());
}
