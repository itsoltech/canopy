import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync as makeTemp, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFileSearchCache, MAX_LIMIT, MAX_WALK, searchFiles } from "./search.ts";

const make = (root: string, files: string[]) => {
  for (const file of files) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "x");
  }
};

afterEach(() => clearFileSearchCache());

// Temporary folders (the huge one alone is 21k files) are removed after the run: /tmp is a small shared tmpfs.
const temps: string[] = [];
const mkdtempSync = (prefix: string) => {
  const dir = makeTemp(prefix);
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("git work tree", () => {
  let repo = "";
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "oa-files-git-"));
    make(repo, ["src/runtime/host.ts", "src/runtime/session.ts", "docs/hosting.md", "notatka-z-lekcji.md", "dist/host.js", "node_modules/x/host.ts", "new/untracked-host.ts"]);
    writeFileSync(join(repo, ".gitignore"), "dist/\nnode_modules/\n");
    await Bun.$`git init -q && git add src docs notatka-z-lekcji.md .gitignore && git -c user.email=t@t -c user.name=t commit -qm init`.cwd(repo);
  });

  test("tracked and untracked files, ignored ones never, best match first", async () => {
    const out = await searchFiles(repo, "host.ts");
    expect(out.source).toBe("git");
    const paths = out.matches.map((m) => m.path);
    expect(paths[0]).toBe("src/runtime/host.ts");
    expect(paths).toContain("new/untracked-host.ts");
    expect(paths.some((p) => p.startsWith("dist/") || p.startsWith("node_modules/"))).toBe(false);
    expect(out.matches[0]?.indices.length).toBe("host.ts".length);
  });

  test("directories come from the files; non-ASCII names stay readable", async () => {
    make(repo, ["źródła/żółw.md"]);
    clearFileSearchCache();
    const out = await searchFiles(repo, "zolw");
    expect(out.matches.length).toBe(0); // no transliteration: characters match as typed
    const exact = await searchFiles(repo, "żółw");
    expect(exact.matches[0]?.path).toBe("źródła/żółw.md");
    const dirs = await searchFiles(repo, "runtime");
    expect(dirs.matches[0]).toMatchObject({ path: "src/runtime", isDir: true });
  });

  test("a subfolder lists only itself, paths relative to it", async () => {
    const out = await searchFiles(join(repo, "src"), "");
    expect(out.matches.map((m) => m.path)).toEqual(["runtime", "runtime/host.ts", "runtime/session.ts"]);
  });

  test("the limit is bounded", async () => {
    expect((await searchFiles(repo, "", 1)).matches).toHaveLength(1);
    expect((await searchFiles(repo, "", 10_000)).matches.length).toBeLessThanOrEqual(MAX_LIMIT);
  });
});

describe("folder without git", () => {
  test("walks without hidden, dependency or symlinked folders", async () => {
    const root = mkdtempSync(join(tmpdir(), "oa-files-walk-"));
    const outside = mkdtempSync(join(tmpdir(), "oa-files-outside-"));
    make(root, ["a/plan.md", ".git2/secret-plan.md", "node_modules/plan.md"]);
    make(outside, ["plan-outside.md"]);
    symlinkSync(outside, join(root, "link"));
    const out = await searchFiles(root, "plan");
    expect(out.source).toBe("walk");
    expect(out.matches.map((m) => m.path)).toEqual(["a/plan.md"]);
  });

  test("a huge folder is cut off and says so", async () => {
    const root = mkdtempSync(join(tmpdir(), "oa-files-big-"));
    for (let d = 0; d < 21; d++) {
      mkdirSync(join(root, `d${d}`));
      for (let f = 0; f < 1000; f++) writeFileSync(join(root, `d${d}`, `f${f}`), "");
    }
    const out = await searchFiles(root, "f999");
    expect(out.truncated).toBe(true);
    expect(MAX_WALK).toBe(20_000);
  }, 30_000);
});
