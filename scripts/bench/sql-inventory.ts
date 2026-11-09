import { Glob } from "bun";
import ts from "typescript";

export interface SqlLocation {
  readonly file: string;
  readonly line: number;
  readonly command: string;
  readonly dynamic: boolean;
  readonly tables: string[];
  readonly review: string[];
  readonly template: string;
}

const sqlStart =
  /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|EXISTS|SET|BEGIN)\b/i;

/** Includes fragments and cold administrative paths; these are candidates, not confirmed defects. */
export async function sqlInventory() {
  const entries: SqlLocation[] = [];

  const record = (file: string, line: number, text: string, dynamic: boolean) => {
    const command = sqlStart.exec(text)?.[1]?.toUpperCase();

    if (!command) return;

    const tables = [
      ...new Set(
        [...text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+([a-z_][a-z_0-9]*)/gi)].map((match) =>
          match[1]!.toLowerCase(),
        ),
      ),
    ];

    const review: string[] = [];

    if (/SELECT\s+(?:\w+\.)?\*/i.test(text)) review.push("projection");

    if (command === "SELECT" && !/\bLIMIT\b/i.test(text)) review.push("cardinality");

    if (/\bFOR\s+UPDATE\b/i.test(text)) review.push("lock-duration");

    if (/\b(?:jsonb?_agg|string_agg)\s*\(/i.test(text)) review.push("aggregate-size");

    if (/\bDELETE\s+FROM\b/i.test(text)) review.push("retention-or-deletion");

    if (dynamic) review.push("dynamic-fragment");

    entries.push({ file, line, command, dynamic, tables, review, template: text });
  };

  for (const root of ["apps/gateway/src", "packages/db/src"]) {
    for await (const file of new Glob("**/*.{ts,sql}").scan(root)) {
      if (file.endsWith(".test.ts")) continue;
      const path = `${root}/${file}`;
      const text = await Bun.file(path).text();

      if (file.endsWith(".sql")) {
        for (const [index, line] of text.split("\n").entries()) record(path, index + 1, line, false);
        continue;
      }

      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          record(path, source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, node.text, false);
        } else if (ts.isTemplateExpression(node)) {
          const sql = node.head.text + node.templateSpans.map((span) => ` ? ${span.literal.text}`).join("");
          record(path, source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, sql, true);
        }

        ts.forEachChild(node, visit);
      };

      visit(source);
    }
  }

  return entries;
}

/** Ignore formatting and parameter numbering, preserving string literals and quoted identifier case. */
export function normalizedSql(template: string) {
  const tokens =
    template.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\$\d+\b|[A-Za-z_][A-Za-z_0-9$]*|::|<=|>=|<>|!=|\S/g) ?? [];

  return tokens
    .map((token) =>
      token.startsWith("'") || (token.startsWith('"') && !/^"[a-z_][a-z_0-9]*"$/.test(token))
        ? token
        : /^\$\d+$/.test(token)
          ? "?"
          : token.replace(/^"([a-z_][a-z_0-9]*)"$/, "$1").toLowerCase(),
    )
    .join(" ");
}

let sourceIndex: Promise<Map<string, { file: string; line: number }[]>> | undefined;

/** Candidate source locations only: matching a template cannot identify which caller ran. */
export function sqlSourceIndex() {
  return (sourceIndex ??= sqlInventory().then((entries) => {
    const result = new Map<string, { file: string; line: number }[]>();

    for (const { file, line, template } of entries) {
      const key = normalizedSql(template);
      const matches = result.get(key) ?? [];
      matches.push({ file, line });
      result.set(key, matches);
    }

    return result;
  }));
}
