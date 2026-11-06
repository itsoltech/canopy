import { expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AdoptImportedSessionSchema, RemoveImportedCopySchema, type ImportSnapshot } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { adoptImportedSession, removeImportedCopy } from "./adopt.ts";
import { installFixtureHome } from "./fixtures/install.ts";
import { WorkerImport } from "./service.ts";

/**
 * Security of native copies (docs/import.md, "Kontynuacja"): writes never go through a link, a copy is masked, and
 * Remove deletes exactly what an import wrote.
 */

const temp = tempDirs();

async function setup() {
  const root = temp("canopy-import-adopt-");
  const home = join(root, "home");
  const dataDir = join(root, "data");
  installFixtureHome(home, ["claude"]);
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ token: "adopt-secret-CANARY-0042" }));

  const service = new WorkerImport({
    dataDir,
    homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
    config: () => undefined,
  });

  const privateHome = join(dataDir, "claude-home");
  const summaries = () => service.scan(["claude"]).then((s) => s.threads);
  const summary = (await summaries()).find((t) => t.cwd === join(home, "project"))!;
  const projectDir = readdirSync(join(home, ".claude", "projects")).find((d) => d.endsWith("-project"))!;

  const adopt = (replace = false, current = summary) =>
    adoptImportedSession(
      service,
      {
        claudeHome: () => privateHome,
        codexHome: () => join(dataDir, "codex-home"),
        grokSessions: () => join(dataDir, "grok", "native", "sessions"),
      },
      create(AdoptImportedSessionSchema, { sourceKey: current.sourceKey, snapshot: current.snapshot, replace }),
    );

  const remove = (sessionId: string) =>
    removeImportedCopy(
      service,
      { claudeHome: () => privateHome, codexHome: () => privateHome, grokSessions: () => privateHome },
      create(RemoveImportedCopySchema, { agentCli: "claude", sessionId }),
    );

  return { root, home, privateHome, summary, summaries, projectDir, adopt, remove, service };
}

test("a copy is masked: a secret in the session does not reach the private home", async () => {
  const { home, privateHome, projectDir, summaries, adopt } = await setup();
  const session = readdirSync(join(home, ".claude", "projects", projectDir)).find((f) => f.endsWith(".jsonl"))!;
  appendFileSync(
    join(home, ".claude", "projects", projectDir, session),
    `${JSON.stringify({ type: "user", uuid: "s1", parentUuid: null, message: { role: "user", content: 'key "adopt-secret-CANARY-0042"' } })}\n`,
  );
  const current = (await summaries()).find((t) => t.cwd === join(home, "project"))!;
  const sessionId = adopt(false, current);
  const copy = readFileSync(join(privateHome, "projects", projectDir, `${sessionId}.jsonl`), "utf8");

  expect(copy).not.toContain("CANARY");
  expect(copy).toContain("[redacted]");
  // Lines without a secret keep their bytes.
  expect(copy.split("\n")[0]).toBe(
    readFileSync(join(home, ".claude", "projects", projectDir, session), "utf8").split("\n")[0],
  );
});

test("links in the private home are never written through: a linked directory or a planted file at the target", async () => {
  const { root, privateHome, projectDir, summary, adopt } = await setup();
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep.txt"), "untouched");

  // The project directory of the copy is a link out of the private home.
  mkdirSync(join(privateHome, "projects"), { recursive: true });
  symlinkSync(outside, join(privateHome, "projects", projectDir));
  expect(() => adopt()).toThrow("link");
  expect(readdirSync(outside)).toEqual(["keep.txt"]);

  // The target itself is a link to a file outside (an old `.importing` name or the session file).
  rmSync(join(privateHome, "projects", projectDir));
  mkdirSync(join(privateHome, "projects", projectDir));
  symlinkSync(join(outside, "keep.txt"), join(privateHome, "projects", projectDir, `${summary.nativeId}.jsonl`));
  expect(() => adopt(true)).toThrow("link");
  expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("untouched");
});

test("a file Canopy did not write is never replaced; Remove deletes only what the manifest lists", async () => {
  const { root, privateHome, projectDir, summary, adopt, remove } = await setup();
  const target = join(privateHome, "projects", projectDir, `${summary.nativeId}.jsonl`);
  mkdirSync(join(privateHome, "projects", projectDir), { recursive: true });
  writeFileSync(target, "the user's own copy\n");
  expect(() => adopt(true)).toThrow("different copy");
  expect(readFileSync(target, "utf8")).toBe("the user's own copy\n");

  // Remove without a manifest deletes nothing, also not a same-named session elsewhere.
  remove(summary.nativeId);
  expect(existsSync(target)).toBe(true);

  rmSync(target);
  const sessionId = adopt();
  // Same-named files outside what the import wrote stay: another project dir, and one behind a link.
  const other = join(privateHome, "projects", "-other-project", `${sessionId}.jsonl`);
  mkdirSync(join(privateHome, "projects", "-other-project"), { recursive: true });
  writeFileSync(other, "kept");
  const outside = join(root, "outside-projects");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, `${sessionId}.jsonl`), "kept");
  symlinkSync(outside, join(privateHome, "projects", "-linked"));

  remove(sessionId);
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(other, "utf8")).toBe("kept");
  expect(readFileSync(join(outside, `${sessionId}.jsonl`), "utf8")).toBe("kept");
  // Adopting again works: the manifest is gone with the copy.
  expect(adopt()).toBe(sessionId);
});

test("a session that cannot be masked record by record is not continued natively", async () => {
  const { home, projectDir, summaries, adopt } = await setup();
  const session = readdirSync(join(home, ".claude", "projects", projectDir)).find((f) => f.endsWith(".jsonl"))!;
  appendFileSync(join(home, ".claude", "projects", projectDir, session), "{not json\n");
  const current = (await summaries()).find((t) => t.cwd === join(home, "project"))!;

  expect(() => adopt(false, current)).toThrow("can't be masked");
});

test("Remove deletes nothing when the private home was swapped for a link or another directory", async () => {
  const { root, privateHome, projectDir, adopt, remove } = await setup();
  const sessionId = adopt();
  const rel = join("projects", projectDir, `${sessionId}.jsonl`);
  // Another directory with the same relative file, put where the private home was.
  const other = join(root, "other-home");
  mkdirSync(join(other, "projects", projectDir), { recursive: true });
  writeFileSync(join(other, rel), "unrelated");
  renameSync(privateHome, join(root, "moved-home"));
  symlinkSync(other, privateHome);
  remove(sessionId);
  expect(readFileSync(join(other, rel), "utf8")).toBe("unrelated");

  // A real directory, but not the recorded one.
  rmSync(privateHome);
  mkdirSync(join(privateHome, "projects", projectDir), { recursive: true });
  writeFileSync(join(privateHome, rel), "also unrelated");
  remove(sessionId);
  expect(readFileSync(join(privateHome, rel), "utf8")).toBe("also unrelated");
});

test("a failed copy leaves nothing behind, and a retry after the fix succeeds", async () => {
  const { home, privateHome, projectDir, summary, adopt, remove } = await setup();
  const sidecar = join(home, ".claude", "projects", projectDir, summary.nativeId, "subagents");
  mkdirSync(sidecar, { recursive: true });
  writeFileSync(join(sidecar, "agent-bad.jsonl"), "{not json\n");

  expect(() => adopt()).toThrow("can't be masked");
  const leftovers = readdirSync(privateHome, { recursive: true }).map(String);
  expect(leftovers.filter((p) => p.endsWith(".jsonl") || p.includes(".canopy-import-"))).toEqual([]);

  writeFileSync(join(sidecar, "agent-bad.jsonl"), `${JSON.stringify({ type: "assistant", uuid: "s1" })}\n`);
  const sessionId = adopt();
  expect(existsSync(join(privateHome, "projects", projectDir, `${sessionId}.jsonl`))).toBe(true);
  remove(sessionId);
  expect(existsSync(join(privateHome, "projects", projectDir, `${sessionId}.jsonl`))).toBe(false);
});

test("a publication stopped after its manifest and before its renames is finished by the next attempt", async () => {
  const { privateHome, projectDir, adopt, remove, service } = await setup();
  const sessionId = adopt();
  const target = join(privateHome, "projects", projectDir, `${sessionId}.jsonl`);
  const manifestPath = service.copyManifest("claude", "", sessionId);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // As if a worker had written the pending manifest and moved this file into place, then stopped.
  writeFileSync(`${target}.next`, "half-published\n");
  renameSync(`${target}.next`, target);
  const moved = lstatSync(target, { bigint: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      ...manifest,
      pending: {
        files: [
          { rel: join("projects", projectDir, `${sessionId}.jsonl`), dev: String(moved.dev), ino: String(moved.ino) },
        ],
        size: "1",
        prefixSha256: "interrupted",
      },
    }),
  );

  // Not the same copy (pending), and the file is Canopy's own: the retry publishes over it.
  expect(adopt()).toBe(sessionId);
  expect(readFileSync(target, "utf8")).not.toBe("half-published\n");
  expect(JSON.parse(readFileSync(manifestPath, "utf8")).pending).toBeUndefined();
  remove(sessionId);
  expect(existsSync(target)).toBe(false);
});

test("a file only an interrupted publication wrote stays recorded through the retry, and Remove deletes it", async () => {
  const { privateHome, projectDir, adopt, remove, service } = await setup();
  const sessionId = adopt();
  const manifestPath = service.copyManifest("claude", "", sessionId);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // An interrupted publication had moved a companion the retry does not write again.
  const rel = join("projects", projectDir, sessionId, "tool-results", "only-pending.txt");
  mkdirSync(join(privateHome, "projects", projectDir, sessionId, "tool-results"), { recursive: true });
  writeFileSync(join(privateHome, rel), "pending companion");
  const stat = lstatSync(join(privateHome, rel), { bigint: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      ...manifest,
      pending: { files: [{ rel, dev: String(stat.dev), ino: String(stat.ino) }], size: "1", prefixSha256: "x" },
    }),
  );

  adopt();
  const final = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(final.pending).toBeUndefined();
  expect(final.files.some((f: { rel: string }) => f.rel === rel)).toBe(true);
  remove(sessionId);
  expect(existsSync(join(privateHome, rel))).toBe(false);
});

test("a tampered manifest with `..` inside a path deletes nothing outside the private home", async () => {
  const { privateHome, adopt, remove, service } = await setup();
  const sessionId = adopt();
  // Where `safe/../../outside-victim.txt` leads from the private home: outside it.
  const outside = join(privateHome, "..", "outside-victim.txt");
  writeFileSync(outside, "keep");
  const stat = lstatSync(outside, { bigint: true });
  const manifestPath = service.copyManifest("claude", "", sessionId);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  mkdirSync(join(privateHome, "safe"), { recursive: true });
  const traversal = join("safe", "..", "..", "outside-victim.txt");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      ...manifest,
      files: [...manifest.files, { rel: traversal, dev: String(stat.dev), ino: String(stat.ino) }],
    }),
  );

  remove(sessionId);
  expect(readFileSync(outside, "utf8")).toBe("keep");
});

test("a Grok copy holds the session as the scan saw it: a prompt added later stays out", async () => {
  const root = temp("canopy-import-adopt-grok-");
  const home = join(root, "home");
  const dataDir = join(root, "data");
  installFixtureHome(home, ["grok"]);

  const service = new WorkerImport({
    dataDir,
    homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
    config: () => undefined,
  });

  const summary = (await service.scan(["grok"])).threads[0]!;
  const group = join(home, ".grok", "sessions", encodeURIComponent(join(home, "project")));
  const session = join(group, summary.nativeId);
  // After the scan the CLI goes on: a new prompt in both logs.
  appendFileSync(
    join(session, "updates.jsonl"),
    `${JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "LATER_PROMPT" } } } })}\n`,
  );
  appendFileSync(
    join(session, "chat_history.jsonl"),
    `${JSON.stringify({ type: "user", prompt_index: 9, content: "LATER_PROMPT" })}\n`,
  );
  // And an answer that grew after the scan without any new prompt (an interactive session logs none).
  appendFileSync(
    join(session, "chat_history.jsonl"),
    `${JSON.stringify({ type: "assistant", content: "LATER_ANSWER" })}\n`,
  );
  const sessions = join(dataDir, "grok", "native", "sessions");

  const sessionId = adoptImportedSession(
    service,
    { claudeHome: () => "", codexHome: () => "", grokSessions: () => sessions },
    create(AdoptImportedSessionSchema, { sourceKey: summary.sourceKey, snapshot: summary.snapshot }),
  );

  const copied = join(sessions, encodeURIComponent(join(home, "project")), sessionId);

  expect(readFileSync(join(copied, "chat_history.jsonl"), "utf8")).not.toContain("LATER_PROMPT");
  expect(readFileSync(join(copied, "chat_history.jsonl"), "utf8")).not.toContain("LATER_ANSWER");
  expect(readFileSync(join(copied, "updates.jsonl"), "utf8")).not.toContain("LATER_PROMPT");
  expect(readFileSync(join(copied, "chat_history.jsonl"), "utf8")).toContain("FIXTURE_TOOL");
  expect(readdirSync(copied).some((f) => f.endsWith(".lock"))).toBe(false);
});

test("without a snapshot of the chat history a Grok session is not continued natively", async () => {
  const root = temp("canopy-import-adopt-grok-old-");
  const home = join(root, "home");
  installFixtureHome(home, ["grok"]);

  const service = new WorkerImport({
    dataDir: join(root, "data"),
    homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
    config: () => undefined,
  });

  const summary = (await service.scan(["grok"])).threads[0]!;
  expect(summary.snapshot?.historyPrefixSha256).toBeTruthy();
  const snapshot = { ...summary.snapshot!, historySize: 0n, historyPrefixSha256: "" };

  expect(() =>
    adoptImportedSession(
      service,
      {
        claudeHome: () => "",
        codexHome: () => "",
        grokSessions: () => join(root, "data", "grok", "native", "sessions"),
      },
      create(AdoptImportedSessionSchema, { sourceKey: summary.sourceKey, snapshot }),
    ),
  ).toThrow("scan again to continue natively");
});

test("a Grok copy is reused only for the same scan of both files", async () => {
  const root = temp("canopy-import-adopt-grok-reuse-");
  const home = join(root, "home");
  installFixtureHome(home, ["grok"]);

  const service = new WorkerImport({
    dataDir: join(root, "data"),
    homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
    config: () => undefined,
  });

  const sessions = join(root, "data", "grok", "native", "sessions");

  const adopt = (summary: { sourceKey: string; snapshot?: ImportSnapshot | undefined }) =>
    adoptImportedSession(
      service,
      { claudeHome: () => "", codexHome: () => "", grokSessions: () => sessions },
      create(AdoptImportedSessionSchema, { sourceKey: summary.sourceKey, snapshot: summary.snapshot }),
    );

  const older = (await service.scan(["grok"])).threads[0]!;
  const session = join(home, ".grok", "sessions", encodeURIComponent(join(home, "project")), older.nativeId);
  // The chat history grows (an answer, no new ACP record): a newer scan, a newer copy.
  appendFileSync(
    join(session, "chat_history.jsonl"),
    `${JSON.stringify({ type: "assistant", content: "NEWER_ANSWER" })}\n`,
  );
  const newer = (await service.scan(["grok"])).threads[0]!;
  const id = adopt(newer);
  const chat = join(sessions, encodeURIComponent(join(home, "project")), id, "chat_history.jsonl");
  expect(readFileSync(chat, "utf8")).toContain("NEWER_ANSWER");

  // The older scan's copy is made again, not the newer one reused.
  adopt(older);
  expect(readFileSync(chat, "utf8")).not.toContain("NEWER_ANSWER");
});
