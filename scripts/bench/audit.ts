import { Glob } from "bun";
import ts from "typescript";

/** Static inventory complements runtime traces: fragments and cold administrative paths are included. */
interface Entry {
  readonly file: string;
  readonly line: number;
  readonly command: string;
  readonly dynamic: boolean;
  readonly tables: string[];
  readonly review: string[];
}

const entries: Entry[] = [];

const sqlStart =
  /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|EXISTS|SET|BEGIN)\b/i;

function record(file: string, line: number, text: string, dynamic: boolean) {
  const command = sqlStart.exec(text)?.[1]?.toUpperCase();

  if (!command) return;

  const tables = [
    ...new Set(
      [...text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+([a-z_][a-z_0-9]*)/gi)].map((match) =>
        match[1]!.toLowerCase(),
      ),
    ),
  ];

  const review = [];

  if (/SELECT\s+(?:\w+\.)?\*/i.test(text)) review.push("projection");

  if (command === "SELECT" && !/\bLIMIT\b/i.test(text)) review.push("cardinality");

  if (/\bFOR\s+UPDATE\b/i.test(text)) review.push("lock-duration");

  if (/\b(?:jsonb?_agg|string_agg)\s*\(/i.test(text)) review.push("aggregate-size");

  if (/\bDELETE\s+FROM\b/i.test(text)) review.push("retention-or-deletion");

  if (dynamic) review.push("dynamic-fragment");
  entries.push({ file, line, command, dynamic, tables, review });
}

for (const root of ["apps/gateway/src", "packages/db/src"]) {
  for await (const file of new Glob("**/*.{ts,sql}").scan(root)) {
    if (file.endsWith(".test.ts")) continue;
    const path = `${root}/${file}`;
    const text = await Bun.file(path).text();

    if (file.endsWith(".sql")) {
      // SQL bodies may contain internal statements. Keep migration location and every statement start for review.
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

console.log(
  JSON.stringify(
    {
      note: "Static review candidates, not confirmed defects. Fragments may overlap; dynamically assembled SQL requires source review. No values or SQL text are emitted.",
      entries,
    },
    null,
    2,
  ),
);
