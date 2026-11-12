import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { Provider } from "@canopy/contracts";
import { join } from "node:path";
import { existsSync, readFileSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { BOT_FILE_BYTES } from "../../apps/worker/src/bots/workspace.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";
import { eventually } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("isolated bot workspaces through gateway and worker", () => {
  let f: HarnessBots;
  beforeAll(async () => {
    f = await harnessBots();
  }, 30_000);
  afterAll(async () => {
    await f?.close();
  });

  for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    test(`${Provider[provider]} writes only its conversation files and Files off is enforced`, async () => {
      const bot = await f.add(provider, f.workerId, "full_auto");
      await f.tool(bot.id, "write_file", { path: "note.md", text: "# My note" });
      await f.settled(bot.id);
      const path = join(f.dataDir, "bots", bot.id, "workspace", "note.md");
      expect(readFileSync(path, "utf8")).toBe("# My note");

      await f.tool(bot.id, "write_file", { path: "../escape.txt", text: "escape" });
      expect((await f.settled(bot.id)).messages.at(-1)?.text).toContain("filename");
      const other = await f.add(provider, f.workerId, "full_auto");
      await f.tool(other.id, "read_file", { path: path });
      expect((await f.settled(other.id)).messages.at(-1)?.text).not.toContain("# My note");

      const outside = join(f.dir, `outside-${bot.id}.txt`);
      writeFileSync(outside, "HOST PRIVATE");
      symlinkSync(outside, join(f.dataDir, "bots", bot.id, "workspace", "link.txt"));
      await f.tool(bot.id, "read_file", { path: "link.txt" });
      expect((await f.settled(bot.id)).messages.at(-1)?.text).not.toContain("HOST PRIVATE");

      await f.gw.api.updateBot({ botId: bot.id, configuration: { ...bot.configuration!, files: false } });
      await f.tool(bot.id, "write_file", { path: "disabled.txt", text: "no" });
      await f.settled(bot.id);
      expect(existsSync(join(f.dataDir, "bots", bot.id, "workspace", "disabled.txt"))).toBe(false);
    });
  }

  test("worker enforces disk quotas and cleans expired scratch after restart", async () => {
    const bot = await f.add(Provider.CODEX, f.workerId, "full_auto");
    await f.tool(bot.id, "write_file", { path: "note.md", text: "Keep this note" });
    await f.settled(bot.id);
    const path = join(f.dataDir, "bots", bot.id, "workspace");

    for (const name of ["a.bin", "b.bin", "c.bin", "d.bin"]) {
      writeFileSync(join(path, name), "");
      truncateSync(join(path, name), BOT_FILE_BYTES);
    }

    await f.tool(bot.id, "write_file", { path: "overflow.txt", text: "no space" });
    expect((await f.settled(bot.id)).messages.at(-1)?.text).toContain("full");
    expect(existsSync(join(path, "overflow.txt"))).toBe(false);
    await f.restartWorker();
    await f.tool(bot.id, "read_file", { path: "note.md" });
    expect((await f.settled(bot.id)).messages.at(-1)?.text).toContain("Keep this note");
    await eventually(
      async () => f.host.runningTurns().some((turn) => turn.threadId === bot.id),
      (active) => !active,
    );
    utimesSync(path, new Date(0), new Date(0));
    await f.restartWorker();
    expect(existsSync(path)).toBe(false);
    await f.tool(bot.id, "read_file", { path: "note.md" });
    expect((await f.settled(bot.id)).messages.at(-1)?.text).not.toContain("Keep this note");
  }, 30_000);
});
