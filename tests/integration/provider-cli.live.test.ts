/**
 * Opt-in (CANOPY_LIVE=1): the official sources of the latest provider CLI versions answer with a version
 * (docs/provider-cli.md). Reads only; nothing is installed.
 */
import { expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { CliLatestSource } from "@canopy/gateway/core/cli-tools";

test.skipIf(process.env["CANOPY_LIVE"] !== "1")(
  "latest Claude Code, Codex and Grok versions from their official sources",
  async () => {
    const source = new CliLatestSource();
    await source.refresh();

    for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
      const latest = source.get(provider);
      console.info(`${Provider[provider]}: ${latest?.version} ${latest?.error}`);
      expect(latest?.error).toBe("");
      expect(latest?.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  },
  30_000,
);
