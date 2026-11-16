import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Provider } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { WorkerImport } from "../import/service.ts";
import { removeThreadStorage } from "./storage-files.ts";

const root = tempDir("canopy-storage-files-");
const dataDir = join(root, "data");
const threadId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";

const grant = {
  threadId,
  provider: Provider.CODEX,
  providerProfileId: "native",
  providerThreadIds: [sessionId],
  homePath: join(dataDir, "codex-home"),
};

test("removes only the managed thread attachment and exact native session", () => {
  const managed = join(dataDir, "codex-home", "sessions", "2026", "11", "16");
  const attachment = join(dataDir, "attachments", threadId, "attachment", "file.txt");
  const global = join(root, "global", "sessions", "same-name.jsonl");
  const project = join(dataDir, "worktrees", "project", "keep.txt");
  const scratch = join(dataDir, "scratch", "keep.txt");
  mkdirSync(managed, { recursive: true });
  mkdirSync(join(attachment, ".."), { recursive: true });
  mkdirSync(join(global, ".."), { recursive: true });
  mkdirSync(join(project, ".."), { recursive: true });
  mkdirSync(join(scratch, ".."), { recursive: true });
  writeFileSync(
    join(managed, `rollout-2026-11-16T00-00-00-${sessionId}.jsonl`),
    `{"type":"session_meta","payload":{"id":"${sessionId}"}}\n`,
  );
  writeFileSync(attachment, "attachment");
  writeFileSync(global, "global");
  writeFileSync(project, "project");
  writeFileSync(scratch, "scratch");

  removeThreadStorage(dataDir, grant, grant.homePath);

  expect(existsSync(join(dataDir, "attachments", threadId))).toBe(false);
  expect(existsSync(join(managed, `rollout-2026-11-16T00-00-00-${sessionId}.jsonl`))).toBe(false);
  expect(existsSync(global)).toBe(true);
  expect(existsSync(project)).toBe(true);
  expect(existsSync(scratch)).toBe(true);
});

test("an import manifest pins the session while cleanup still removes thread attachments", () => {
  const managed = join(dataDir, "codex-home", "sessions", "2026", "11", "16");
  const attachment = join(dataDir, "attachments", threadId, "attachment");

  const service = new WorkerImport({
    dataDir,
    homes: () => ({ claude: join(root, "claude"), codex: join(root, "codex"), grok: join(root, "grok") }),
    config: () => undefined,
  });

  mkdirSync(managed, { recursive: true });
  mkdirSync(attachment, { recursive: true });
  const session = join(managed, `rollout-2026-11-16T00-00-00-${sessionId}.jsonl`);
  writeFileSync(session, `{"type":"session_meta","payload":{"id":"${sessionId}"}}\n`);
  mkdirSync(join(service.copyManifest("codex", "native", sessionId), ".."), { recursive: true });
  writeFileSync(service.copyManifest("codex", "native", sessionId), "{}\n");

  removeThreadStorage(dataDir, grant, grant.homePath, new Set([sessionId]));

  expect(existsSync(session)).toBe(true);
  expect(existsSync(join(dataDir, "attachments", threadId))).toBe(false);
});
