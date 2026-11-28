import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  ThreadTransferOperationSchema,
  ThreadTransferSessionSchema,
  WorkspaceCopyReadSchema,
  type ThreadTransferSession,
} from "@canopy/contracts";
import { COPY_FRAME_BYTES } from "@canopy/domain/workspace-copy";
import { tempDir } from "@canopy/testing";
import { createHash } from "node:crypto";
import { ThreadTransfers, type ThreadTransferHost } from "./index.ts";

/**
 * The worker side of a thread transfer between two workers (docs/thread-transfers.md), with real Git: the source
 * exports, the target stages, fetches only the missing commits, recreates the changes in a fresh worktree and adopts
 * the Claude session in its own home. A cancelled move puts back the session the target held before.
 */

const dir = tempDir("canopy-thread-transfer-worker-");

const env = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" };

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...env } });

  if (result.exitCode) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

const SESSION = "0b8e4c7e-1d2a-4f3b-9c5d-6e7f8a9b0c1d";
const THREAD = "1c9f5d8f-2e3b-4a4c-8d6e-7f8a9b0c1d2e";

/** A side thread of the same family, with its own session in the same project directory. */
const SIDE_SESSION = "2d0a6e9a-3f4c-4b5d-9e7f-8a9b0c1d2e3f";
const SIDE_THREAD = "3e1b7f0b-4a5d-4c6e-8f8a-9b0c1d2e3f4a";

/**
 * `owned`: the target ran these sessions before (its journal binds them to this home). `secret`: the journal marks
 * the history as holding a project secret.
 */
function host(name: string, claudeHome: string, owned = true, secret = false): ThreadTransferHost {
  return {
    dataDir: join(dir, name, "data"),
    locate: { claudeHomes: async () => [claudeHome], codexHomes: async () => [], secretHistory: async () => secret },
    adoptionHome: async (session) => ({
      home: claudeHome,
      manifest: join(dir, name, "data", "manifests", `${session.providerThreadId}.json`),
      owned,
    }),
    bindCliHome: async () => {},
    unbindCliHome: async () => {},
    codexHistory: { has: async () => false, set: async () => {} },
  };
}

const op = (action: NonNullable<MessageInitShape<typeof ThreadTransferOperationSchema>["action"]>) =>
  create(ThreadTransferOperationSchema, { action });

/** Moves every package file from the source to the target in frames, as the gateway does. */
async function transfer(source: ThreadTransfers, target: ThreadTransfers, token: string, cwd: string, extra = {}) {
  const sessions: ThreadTransferSession[] = [
    create(ThreadTransferSessionSchema, { threadId: THREAD, provider: "claude", providerThreadId: SESSION }),
    create(ThreadTransferSessionSchema, { threadId: SIDE_THREAD, provider: "claude", providerThreadId: SIDE_SESSION }),
  ];

  const tips = await target.execute(op({ case: "tips", value: { repoPath: join(dir, "b", "repo") } }));

  const exported = await source.execute(
    op({ case: "export", value: { token, cwd, sessions, knownCommits: tips.tips, ...extra } }),
  );

  const pkg = exported.package!;
  await target.execute(op({ case: "prepare", value: { token, entries: pkg.entries, bytes: pkg.bytes } }));
  const total = createHash("sha256");

  for (const entry of pkg.entries) {
    let offset = 0n;
    let sha = "";

    for (;;) {
      const read = create(WorkspaceCopyReadSchema, { token, path: entry.path, offset, maxBytes: COPY_FRAME_BYTES });
      const batch = (await source.execute(op({ case: "readBatch", value: { token, reads: [read] } }))).batch!;
      await target.execute(op({ case: "writeBatch", value: { token, chunks: batch.chunks } }));
      const chunk = batch.chunks[0]!;
      offset += BigInt(chunk.data.length);
      sha = chunk.sha256;

      if (chunk.last) break;
    }

    total.update(`${entry.path}\0${entry.size}\0${sha}\n`);
  }

  const staged = await target.execute(
    op({ case: "stage", value: { token, sha256: total.digest("hex"), repoPath: join(dir, "b", "repo") } }),
  );

  return { pkg, staged };
}

describe("thread transfer between two workers", () => {
  const origin = join(dir, "origin.git");
  const repoA = join(dir, "a", "repo");
  const repoB = join(dir, "b", "repo");
  const homeA = join(dir, "a", "claude");
  const homeB = join(dir, "b", "claude");
  const project = join("projects", "-old-folder");

  test("recreates the checkout and adopts the session; a cancel restores what the target had", async () => {
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(dir, "clone", "-q", origin, repoA);
    writeFileSync(join(repoA, ".gitignore"), ".env\n");
    writeFileSync(join(repoA, "app.txt"), "one\n");
    writeFileSync(join(repoA, "bin.dat"), Buffer.from([0, 1, 2, 255]));
    git(repoA, "add", ".");
    git(repoA, "commit", "-qm", "base");
    git(repoA, "push", "-qu", "origin", "main");
    git(dir, "clone", "-q", origin, repoB);

    // Unpushed commit, a staged rename-free edit, an unstaged edit on top, a deletion, a binary change, a new script.
    writeFileSync(join(repoA, "local.txt"), "local\n");
    git(repoA, "add", "local.txt");
    git(repoA, "commit", "-qm", "local");
    writeFileSync(join(repoA, "app.txt"), "one\nstaged\n");
    git(repoA, "add", "app.txt");
    writeFileSync(join(repoA, "app.txt"), "one\nstaged\nunstaged\n");
    git(repoA, "rm", "-q", "--cached", "bin.dat");
    writeFileSync(join(repoA, "bin.dat"), Buffer.from([9, 9]));
    writeFileSync(join(repoA, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(repoA, ".env"), "SECRET=1\n");
    // A new, not ignored key file: offered like local files and never moved unchosen.
    writeFileSync(join(repoA, "deploy.pem"), "KEY\n");

    mkdirSync(join(homeA, project, SESSION, "subagents"), { recursive: true });
    writeFileSync(join(homeA, project, `${SESSION}.jsonl`), '{"type":"user"}\n');
    writeFileSync(join(homeA, project, SESSION, "subagents", "agent-1.jsonl"), '{"type":"agent"}\n');
    writeFileSync(join(homeA, project, `${SIDE_SESSION}.jsonl`), '{"type":"side"}\n');
    // The target held older copies of both sessions (the family lived there before).
    mkdirSync(join(homeB, project), { recursive: true });
    writeFileSync(join(homeB, project, `${SESSION}.jsonl`), '{"type":"old"}\n');
    writeFileSync(join(homeB, project, `${SIDE_SESSION}.jsonl`), '{"type":"old side"}\n');

    const source = new ThreadTransfers(host("a", homeA));
    const target = new ThreadTransfers(host("b", homeB));

    const inspected = await source.execute(op({ case: "inspect", value: { cwd: repoA, sessions: [] } }));
    expect(inspected.summary).toMatchObject({ blocked: "", unpushedCommits: 1, untrackedFiles: 3 });
    expect(inspected.summary?.localFiles.map((f) => [f.path, f.secret])).toEqual([
      ["deploy.pem", true],
      [".env", true],
    ]);

    // Cancelled before the commit: the old session copy comes back, the fetched ref goes.
    const first = crypto.randomUUID();
    const { staged } = await transfer(source, target, first, repoA, { localFiles: [".env"] });
    const head = git(repoA, "rev-parse", "HEAD");
    expect(staged.head).toBe(head);
    const worktree1 = join(dir, "b", "wt1");
    git(repoB, "worktree", "add", "-q", "--detach", worktree1, staged.head);

    const sessions = [
      { threadId: THREAD, provider: "claude", profileId: "", providerThreadId: SESSION },
      { threadId: SIDE_THREAD, provider: "claude", profileId: "", providerThreadId: SIDE_SESSION },
    ];

    await target.execute(op({ case: "apply", value: { token: first, cwd: worktree1, sessions } }));
    expect(readFileSync(join(homeB, project, `${SESSION}.jsonl`), "utf8")).toBe('{"type":"user"}\n');
    // A save in the source checkout after the export refuses the commit.
    await source.execute(op({ case: "verify", value: { token: first, cwd: repoA } }));
    writeFileSync(join(repoA, "app.txt"), "one\nstaged\nunstaged\nlate\n");
    await expect(source.execute(op({ case: "verify", value: { token: first, cwd: repoA } }))).rejects.toThrow(
      "The thread's files changed while moving.",
    );
    writeFileSync(join(repoA, "app.txt"), "one\nstaged\nunstaged\n");
    await target.execute(op({ case: "cancel", value: first }));
    await source.execute(op({ case: "release", value: first }));
    expect(readFileSync(join(homeB, project, `${SESSION}.jsonl`), "utf8")).toBe('{"type":"old"}\n');
    expect(readFileSync(join(homeB, project, `${SIDE_SESSION}.jsonl`), "utf8")).toBe('{"type":"old side"}\n');
    expect(existsSync(join(homeB, project, SESSION, "subagents", "agent-1.jsonl"))).toBe(false);
    expect(() => git(repoB, "rev-parse", "--verify", `refs/canopy/transfers/${first}`)).toThrow();

    // The real move.
    const second = crypto.randomUUID();
    await transfer(source, target, second, repoA, { localFiles: [".env"], expectedHead: head });
    const worktree2 = join(dir, "b", "wt2");
    git(repoB, "worktree", "add", "-q", "-b", "moved", worktree2, head);
    await target.execute(op({ case: "apply", value: { token: second, cwd: worktree2, sessions } }));
    await target.execute(op({ case: "release", value: second }));
    await source.execute(op({ case: "release", value: second }));

    expect(git(worktree2, "show", ":app.txt")).toBe("one\nstaged");
    expect(readFileSync(join(worktree2, "app.txt"), "utf8")).toBe("one\nstaged\nunstaged\n");
    expect(git(worktree2, "ls-files", "bin.dat")).toBe("");
    expect([...readFileSync(join(worktree2, "bin.dat"))]).toEqual([9, 9]);
    expect(readFileSync(join(worktree2, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(existsSync(join(worktree2, "deploy.pem"))).toBe(false);
    expect(Bun.file(join(worktree2, "run.sh")).size).toBe(10);
    expect((await Bun.file(join(worktree2, "run.sh")).stat()).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(homeB, project, `${SESSION}.jsonl`), "utf8")).toBe('{"type":"user"}\n');
    expect(readFileSync(join(homeB, project, SESSION, "subagents", "agent-1.jsonl"), "utf8")).toBe(
      '{"type":"agent"}\n',
    );
    expect(() => git(repoB, "rev-parse", "--verify", `refs/canopy/transfers/${second}`)).toThrow();
  }, 60_000);

  /** A staged package for `files` of the session, as if it arrived, ready to apply into a fresh worktree. */
  function forgedPackage(name: string, files: Record<string, string>) {
    const token = crypto.randomUUID();
    const stage = join(dir, "b", "data", "thread-transfers", "in", token, "files");

    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(stage, "sessions", THREAD, rel)), { recursive: true });
      writeFileSync(join(stage, "sessions", THREAD, rel), text);
    }

    const worktree = join(dir, "b", name);
    git(repoB, "worktree", "add", "-q", "--detach", worktree, "HEAD");

    const checkout = {
      head: git(worktree, "rev-parse", "HEAD"),
      branch: "",
      bundle: false,
      indexPatch: false,
      worktreePatch: false,
      files: [],
      modes: {},
      tree: [],
      localFiles: [],
      fingerprint: "",
    };

    const session = { threadId: THREAD, provider: "claude", providerThreadId: SESSION, files: Object.keys(files) };
    writeFileSync(join(stage, "transfer.json"), JSON.stringify({ version: 1, checkout, sessions: [session] }));
    writeFileSync(join(dir, "b", "data", "thread-transfers", "in", token, "state.json"), '{"repo":"","adoptions":[]}');
    const sessions = [{ threadId: THREAD, provider: "claude", profileId: "", providerThreadId: SESSION }];

    return { token, worktree, sessions };
  }

  test("a package naming another file of the harness home is refused before the home changes", async () => {
    const target = new ThreadTransfers(host("b", homeB));
    const settings = join(homeB, "settings.json");
    writeFileSync(settings, "{}\n");
    const { token, worktree, sessions } = forgedPackage("wt3", { "settings.json": "taken\n" });

    await expect(target.execute(op({ case: "apply", value: { token, cwd: worktree, sessions } }))).rejects.toThrow(
      "The moved session is not where its harness keeps it.",
    );
    expect(readFileSync(settings, "utf8")).toBe("{}\n");
    await target.execute(op({ case: "cancel", value: token }));
  });

  test("a copy of the session Canopy does not own on the target (the CLI's own) is never replaced", async () => {
    const target = new ThreadTransfers(host("b", homeB, false));
    // A file of its own (not the one an earlier Canopy copy wrote and its manifest lists).
    const transcript = join(homeB, project, `${SESSION}.jsonl`);
    rmSync(transcript, { force: true });
    writeFileSync(transcript, '{"type":"cli"}\n');
    const rel = `${project}/${SESSION}.jsonl`;
    const { token, worktree, sessions } = forgedPackage("wt4", { [rel]: '{"type":"moved"}\n' });

    await expect(target.execute(op({ case: "apply", value: { token, cwd: worktree, sessions } }))).rejects.toThrow(
      "This worker already has this session outside Canopy.",
    );
    expect(readFileSync(transcript, "utf8")).toBe('{"type":"cli"}\n');
    await target.execute(op({ case: "cancel", value: token }));
  });

  test("a session already elsewhere in a home Canopy does not own is refused, wherever it is kept", async () => {
    const target = new ThreadTransfers(host("b", homeB, false));
    const elsewhere = join(homeB, "projects", "-cli-folder", `${SESSION}.jsonl`);
    mkdirSync(dirname(elsewhere), { recursive: true });
    writeFileSync(elsewhere, '{"type":"cli"}\n');
    rmSync(join(homeB, project), { recursive: true, force: true });
    const rel = `${project}/${SESSION}.jsonl`;
    const { token, worktree, sessions } = forgedPackage("wt5", { [rel]: '{"type":"moved"}\n' });

    await expect(target.execute(op({ case: "apply", value: { token, cwd: worktree, sessions } }))).rejects.toThrow(
      "This worker already has this session outside Canopy.",
    );
    expect(readFileSync(elsewhere, "utf8")).toBe('{"type":"cli"}\n');
    expect(existsSync(join(homeB, rel))).toBe(false);
    await target.execute(op({ case: "cancel", value: token }));
  });

  test("a late cancel of an earlier move leaves the session a later move published", async () => {
    const source = new ThreadTransfers(host("a", homeA));
    const target = new ThreadTransfers(host("b", homeB));
    const transcript = join(homeB, project, `${SESSION}.jsonl`);

    const sessions = [
      { threadId: THREAD, provider: "claude", profileId: "", providerThreadId: SESSION },
      { threadId: SIDE_THREAD, provider: "claude", profileId: "", providerThreadId: SIDE_SESSION },
    ];

    const apply = async (token: string, name: string) => {
      const { staged } = await transfer(source, target, token, repoA, { localFiles: [".env"] });
      const worktree = join(dir, "b", name);
      git(repoB, "worktree", "add", "-q", "--detach", worktree, staged.head);
      await target.execute(op({ case: "apply", value: { token, cwd: worktree, sessions } }));
    };

    // The same bytes arrive twice; the first move's cancel only comes after the second one applied.
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await apply(first, "wt6");
    await apply(second, "wt7");
    await target.execute(op({ case: "cancel", value: first }));
    await target.execute(op({ case: "release", value: second }));

    expect(readFileSync(transcript, "utf8")).toBe('{"type":"user"}\n');
    await source.execute(op({ case: "release", value: first }));
    await source.execute(op({ case: "release", value: second }));
  });

  test("a cancel keeps an adopted transcript something appended to since", async () => {
    const source = new ThreadTransfers(host("a", homeA));
    const target = new ThreadTransfers(host("b", homeB));
    const transcript = join(homeB, project, `${SESSION}.jsonl`);
    const token = crypto.randomUUID();
    const { staged } = await transfer(source, target, token, repoA, { localFiles: [".env"] });
    const worktree = join(dir, "b", "wt8");
    git(repoB, "worktree", "add", "-q", "--detach", worktree, staged.head);

    const sessions = [
      { threadId: THREAD, provider: "claude", profileId: "", providerThreadId: SESSION },
      { threadId: SIDE_THREAD, provider: "claude", profileId: "", providerThreadId: SIDE_SESSION },
    ];

    await target.execute(op({ case: "apply", value: { token, cwd: worktree, sessions } }));
    // The CLI appends a turn to the same file before the move is cancelled.
    appendFileSync(transcript, '{"type":"later"}\n');
    await target.execute(op({ case: "cancel", value: token }));
    await source.execute(op({ case: "release", value: token }));

    expect(readFileSync(transcript, "utf8")).toBe('{"type":"user"}\n{"type":"later"}\n');
  });

  test("a session whose history holds a project secret never leaves its worker", async () => {
    const source = new ThreadTransfers(host("a", homeA, true, true));
    const sessions = [{ threadId: THREAD, provider: "claude", profileId: "", providerThreadId: SESSION }];
    const inspected = await source.execute(op({ case: "inspect", value: { cwd: repoA, sessions } }));
    expect(inspected.summary?.blocked).toContain("holds a project secret");

    await expect(
      source.execute(op({ case: "export", value: { token: crypto.randomUUID(), cwd: repoA, sessions } })),
    ).rejects.toThrow("holds a project secret");
  });

  test("a checkout that moved since the preview is refused", async () => {
    const source = new ThreadTransfers(host("a", homeA));

    await expect(
      source.execute(
        op({
          case: "export",
          value: { token: crypto.randomUUID(), cwd: repoA, sessions: [], expectedHead: "0".repeat(40) },
        }),
      ),
    ).rejects.toThrow("The thread's checkout moved to another commit");
  });
});
