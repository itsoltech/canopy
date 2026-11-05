import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { Schema } from "effect";
import {
  codexBotCatalog,
  codexModelEntry,
  FALLBACK_AUTO_COMPACT_LIMIT,
  FALLBACK_CONTEXT_WINDOW,
} from "./codex-catalog.ts";

const temp = tempDirs();

const Catalog = Schema.fromJsonString(
  Schema.Struct({ models: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }),
);

/** What the official CLI makes of a catalog file: the metadata its compaction and tools are derived from. */
async function parsed(home: string, catalog: ReturnType<typeof codexBotCatalog>) {
  const file = join(home, "bot-model.json");
  writeFileSync(file, JSON.stringify(catalog));

  const child = Bun.spawn(["codex", "debug", "models", "-c", `model_catalog_json=${JSON.stringify(file)}`], {
    env: { ...process.env, CODEX_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });

  return Schema.decodeUnknownSync(Catalog)(await new Response(child.stdout).text()).models[0];
}

test.skipIf(!Bun.which("codex"))("Codex bot catalog takes the real model limits and keeps tools removed", async () => {
  const home = temp("canopy-bot-catalog-");
  const launch = { command: ["codex", "app-server"], env: { ...process.env, CODEX_HOME: home } };
  const list = Bun.spawnSync(["codex", "debug", "models"], { env: launch.env, stdin: "ignore" });
  const model = String(Schema.decodeUnknownSync(Catalog)(list.stdout.toString()).models[0]?.["slug"]);
  const real = await codexModelEntry(launch, model);
  expect(real?.["context_window"]).toBeGreaterThan(0);
  const window = Number(real?.["context_window"]);

  expect(await parsed(home, codexBotCatalog(model, "low", real))).toMatchObject({
    slug: model,
    context_window: window,
    auto_compact_token_limit: Number(real?.["auto_compact_token_limit"] ?? Math.floor(window * 0.9)),
    truncation_policy: real?.["truncation_policy"],
    shell_type: "disabled",
    apply_patch_tool_type: null,
    tool_mode: "direct",
    experimental_supported_tools: [],
    use_responses_lite: false,
  });

  expect(await parsed(home, codexBotCatalog("canopy-unknown-model", "low", undefined))).toMatchObject({
    context_window: FALLBACK_CONTEXT_WINDOW,
    auto_compact_token_limit: FALLBACK_AUTO_COMPACT_LIMIT,
    shell_type: "disabled",
  });
});
