import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A signed-in device for scripted Codex workers, independent of the runner's CLI home. */
export function codexFixtureHomes(dir: string) {
  const codex = join(dir, ".codex");
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture" } }));

  return { codex, claude: join(dir, ".claude"), grok: join(dir, ".grok") };
}
