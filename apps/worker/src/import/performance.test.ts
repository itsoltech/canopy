import { expect, test } from "bun:test";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ReadImportPageSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { readImportPage } from "./pages.ts";
import { WorkerImport } from "./service.ts";

/**
 * Large histories (docs/import.md, "Limity"): a generated Claude session of CANOPY_IMPORT_PERF_MB (default 160 MB),
 * mostly request caches like real sessions, imported page by page. The scan stays a head-and-tail read, pages stay
 * under their budget, and the worker's memory does not grow with the file.
 */

const temp = tempDirs();
const MB = Number(process.env["CANOPY_IMPORT_PERF_MB"] ?? "160");

function generate(path: string, sessionId: string, cwd: string): number {
  const fd = openSync(path, "w");
  const output = "line of tool output ".repeat(400);
  const cache = "x".repeat(64 * 1024);
  let parent = "";
  let turns = 0;
  let written = 0;

  try {
    while (written < MB * 1024 ** 2) {
      const n = turns++;

      const base = {
        sessionId,
        cwd,
        version: "2.1.308",
        timestamp: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
      };

      const lines = [
        { ...base, type: "user", uuid: `u${n}`, parentUuid: parent, message: { role: "user", content: `Prompt ${n}` } },
        { type: "api-request-blob", sessionId, hash: `h${n}`, message: cache },
        {
          ...base,
          type: "assistant",
          uuid: `a${n}`,
          parentUuid: `u${n}`,
          message: {
            id: `m${n}`,
            role: "assistant",
            content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: "ls" } }],
          },
        },
        {
          ...base,
          type: "user",
          uuid: `r${n}`,
          parentUuid: `a${n}`,
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: output }] },
        },
        {
          ...base,
          type: "assistant",
          uuid: `b${n}`,
          parentUuid: `r${n}`,
          message: {
            id: `n${n}`,
            role: "assistant",
            content: [{ type: "text", text: `Answer ${n}` }],
            stop_reason: "end_turn",
          },
        },
      ];

      parent = `b${n}`;
      const chunk = Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      writeSync(fd, chunk);
      written += chunk.length;
    }
  } finally {
    closeSync(fd);
  }

  return turns;
}

test(`imports a ${MB} MB Claude session in bounded pages and memory`, async () => {
  const root = temp("canopy-import-perf-");
  const home = join(root, "home");
  const dir = join(home, ".claude", "projects", "-perf");
  mkdirSync(dir, { recursive: true });
  const sessionId = crypto.randomUUID();
  const expected = generate(join(dir, `${sessionId}.jsonl`), sessionId, home);

  const service = new WorkerImport({
    dataDir: join(root, "data"),
    homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
    config: () => undefined,
  });

  const scanStarted = performance.now();
  const scan = await service.scan(["claude"]);
  const scanMs = performance.now() - scanStarted;
  const summary = scan.threads![0]!;
  Bun.gc(true);
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  let cursor = "";
  let turns = 0;
  let pages = 0;
  const started = performance.now();

  for (;;) {
    const page = readImportPage(
      service,
      create(ReadImportPageSchema, {
        sourceKey: summary.sourceKey,
        snapshot: summary.snapshot,
        cursor,
        threadId: crypto.randomUUID(),
      }),
    );

    turns += page.turns.length;
    pages += 1;
    cursor = page.nextCursor;
    peak = Math.max(peak, process.memoryUsage().rss);

    if (page.done) break;
  }

  const seconds = (performance.now() - started) / 1000;
  console.info(
    `import perf: ${MB} MB, ${turns} turns, ${pages} pages, scan ${Math.round(scanMs)} ms, import ${seconds.toFixed(1)} s ` +
      `(${(MB / seconds).toFixed(1)} MB/s), memory +${Math.round((peak - baseline) / 1024 ** 2)} MB`,
  );
  expect(turns).toBe(expected);
  expect(pages).toBeGreaterThan(1);
  expect(scanMs).toBeLessThan(2_000);
  expect(peak - baseline).toBeLessThan(400 * 1024 ** 2);
}, 300_000);
