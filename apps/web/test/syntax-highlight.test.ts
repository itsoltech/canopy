import { describe, expect, test } from "bun:test";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { codeToTokensBase, createShikiPrimitive } from "@shikijs/primitive";
import { languageOfDiff, parseDiff } from "../src/lib/shared/ui/code/diff.ts";
import { tokenizer as limitedTokenizer } from "../src/lib/shared/ui/code/highlighter.ts";
import { IncrementalHighlight, type HighlightedLine } from "../src/lib/shared/ui/code/incremental.ts";
import { grammars, languageOf, languageOfPath, type LanguageId } from "../src/lib/shared/ui/code/languages.ts";
import { DEFAULT_COLOR, theme } from "../src/lib/shared/ui/code/theme.ts";

const samples: Partial<Record<LanguageId, string>> = {
  typescript: [
    "/** A multi-line",
    " * doc comment */",
    "export async function load(id: string): Promise<User | undefined> {",
    "  const url = `${base}/users/${encodeURIComponent(id)}`;",
    "  const answer = await fetch(url, { headers: { accept: \"application/json\" } });",
    "  return answer.ok ? ((await answer.json()) as User) : undefined;",
    "}",
    "",
    "type User = { readonly name: string; age?: number };",
  ].join("\n"),
  python: ['def greet(name: str) -> str:', '    """Says hello', '    over two lines."""', '    return f"Hello, {name}!"  # done', "", "print(greet('x'), 42)"].join("\n"),
  shellscript: ['#!/usr/bin/env bash', 'set -euo pipefail', 'for f in "$@"; do', '  echo "file: ${f}" | grep -c x', "done", "cat <<EOF", "heredoc $HOME", "EOF"].join("\n"),
  svelte: ['<script lang="ts">', "  let { name }: { name: string } = $props();", "</script>", "", "<p class=\"x\">{name}</p>", "<style>p { color: red; }</style>"].join("\n"),
};

/**
 * Without the per-line time limit: under CPU load (the whole suite, other processes) a line's first tokenization
 * (regexes compile lazily) can pass 50 ms and stay plain, which is not what these tests check.
 */
const tokenizer = (lang: LanguageId) => limitedTokenizer(lang, { timeLimitMs: 0 });

/** Tokens of the whole text in one pass, in the shape the line tokenizer returns. */
function fullPass(lang: LanguageId, text: string): Promise<HighlightedLine[]> {
  return grammars[lang]().then(({ default: grammar }) => {
    const shiki = createShikiPrimitive({ engine: createJavaScriptRegexEngine({ forgiving: true }), themes: [theme], langs: grammar });
    return codeToTokensBase(shiki, text, { lang: grammar.at(-1)?.name ?? lang, theme: theme.name, tokenizeTimeLimit: 0 }).map((tokens, index) => ({
      text: text.split("\n")[index] ?? "",
      tokens: tokens.map((token) => (token.color && token.color !== DEFAULT_COLOR ? { content: token.content, color: token.color } : { content: token.content })),
    }));
  });
}

describe("fence languages", () => {
  test("common tags and aliases map to grammars", () => {
    const expected: Record<string, LanguageId> = {
      ts: "typescript", typescript: "typescript", TypeScript: "typescript", js: "javascript", tsx: "tsx", jsx: "jsx", svelte: "svelte",
      py: "python", rs: "rust", go: "go", golang: "go", sh: "shellscript", bash: "shellscript", zsh: "shellscript", shell: "shellscript",
      json: "json", yaml: "yaml", yml: "yaml", toml: "toml", sql: "sql", html: "html", css: "css", md: "markdown", diff: "diff",
      dockerfile: "docker", Dockerfile: "docker", c: "c", cpp: "cpp", "c++": "cpp", java: "java", kotlin: "kotlin", kt: "kotlin",
      swift: "swift", ruby: "ruby", rb: "ruby", php: "php", "language-ts": "typescript", "py title=\"a.py\"": "python", "ts{1,3}": "typescript",
    };
    for (const [tag, lang] of Object.entries(expected)) expect([tag, languageOf(tag)]).toEqual([tag, lang]);
  });

  test("unknown or missing tags stay plain", () => {
    for (const tag of [undefined, "", "  ", "text", "txt", "plaintext", "output", "brainfuck", "constructor", "__proto__"]) expect(languageOf(tag)).toBeUndefined();
  });

  test("file paths map by extension or well-known name", () => {
    expect(languageOfPath("apps/web/src/a.svelte")).toBe("svelte");
    expect(languageOfPath("x/types.d.ts")).toBe("typescript");
    expect(languageOfPath("Dockerfile")).toBe("docker");
    expect(languageOfPath("deploy/Makefile")).toBe("make");
    expect(languageOfPath(".env")).toBe("dotenv");
    expect(languageOfPath("README")).toBeUndefined();
    expect(languageOfPath("notes.txt")).toBeUndefined();
  });
});

describe("incremental highlighting", () => {
  for (const [lang, text] of Object.entries(samples) as [LanguageId, string][]) {
    test(`${lang}: line by line, as it streams, equals one full pass`, async () => {
      const tokenize = await tokenizer(lang);
      const full = await fullPass(lang, text);
      expect(full.some((line) => line.tokens.some((token) => token.color))).toBe(true);

      const once = new IncrementalHighlight();
      expect(once.advance(text.split("\n"), tokenize)).toBe(true);
      expect(once.lines).toEqual(full);

      // Streaming: the text grows a few characters at a time, partial last lines included.
      const streamed = new IncrementalHighlight();
      let calls = 0;
      const counting: typeof tokenize = (line, state) => (calls++, tokenize(line, state));
      for (let end = 1; end <= text.length; end += 7) streamed.advance(text.slice(0, end).split("\n"), counting);
      streamed.advance(text.split("\n"), counting);
      expect(streamed.lines).toEqual(full);
      // Complete lines are not tokenized again: about one call per step, not one per line per step.
      expect(calls).toBeLessThan(Math.ceil(text.length / 7) + text.split("\n").length * 2);
    });
  }

  test("lines that did not change keep their objects; a changed line and the ones after it are redone", async () => {
    const tokenize = await tokenizer("typescript");
    const work = new IncrementalHighlight();
    work.advance(["const a = 1;", "const b = `x", "y`;"], tokenize);
    const [first, second] = work.lines;
    work.advance(["const a = 1;", "const b = `x", "y`;", "let c;"], tokenize);
    expect(work.lines[0]).toBe(first!);
    expect(work.lines[1]).toBe(second!);
    work.advance(["const a = 1;", "const b = 'x';", "y`;"], tokenize);
    expect(work.lines[0]).toBe(first!);
    expect(work.lines[1]).not.toBe(second!);
    expect(work.lines).toHaveLength(3);
  });

  test("work is cut into slices and resumes where it stopped", async () => {
    const tokenize = await tokenizer("python");
    const source = samples.python!.split("\n");
    const work = new IncrementalHighlight();
    expect(work.advance(source, tokenize, () => false)).toBe(false);
    expect(work.lines).toHaveLength(1);
    while (!work.advance(source, tokenize, () => false));
    expect(work.lines).toEqual(await fullPass("python", samples.python!));
  });

  test("an unterminated fence-like string keeps its state across lines", async () => {
    const tokenize = await tokenizer("python");
    const work = new IncrementalHighlight();
    work.advance(['x = """open', "still inside"], tokenize);
    expect(work.lines[1]?.tokens.every((token) => token.color === "var(--code-string)")).toBe(true);
  });
});

describe("diffs", () => {
  const diff = ["diff --git a/src/a.ts b/src/a.ts", "index 1..2", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,3 @@", " const a = `one", "-two`;", "+three`;", "--- removed comment line", "\\ No newline at end of file", ""].join("\n");

  test("splits into kinds and the two versions of the code", () => {
    const parsed = parseDiff(diff);
    expect(parsed.lines.map((line) => line.kind)).toEqual(["file", "file", "file", "file", "hunk", "ctx", "del", "add", "del", "file"]);
    expect(parsed.next).toBe("const a = `one\nthree`;");
    expect(parsed.old).toBe("const a = `one\ntwo`;\n-- removed comment line");
    expect(parsed.lines.map((line) => line.at)).toEqual([-1, -1, -1, -1, -1, 0, 1, 1, 2, -1]);
  });

  test("text without hunks is plain context", () => {
    const parsed = parseDiff("just\n+text");
    expect(parsed.lines.map((line) => [line.kind, line.code])).toEqual([["ctx", "just"], ["ctx", "+text"]]);
  });

  test("the language comes from the file the diff names", () => {
    expect(languageOfDiff(diff)).toBe("typescript");
    expect(languageOfDiff("--- /dev/null\n+++ b/main.py\n")).toBe("python");
    expect(languageOfDiff("@@ -1 +1 @@\n-a\n+b")).toBeUndefined();
  });
});
