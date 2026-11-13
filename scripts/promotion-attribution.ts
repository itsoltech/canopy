import {
  isPromotionFollowup,
  promotionCommitLinks,
  sharedPromotionFile,
  type PromotionAttribution,
  type PromotionCommit,
} from "./promotion-policy.ts";

type GitReader = (...args: string[]) => string;

interface PreimageRange {
  start: number;
  end: number;
  kind: PromotionAttribution["kind"];
}

function ignoredRevisions(commit: PromotionCommit, git: GitReader): string[] {
  const path = ".git-blame-ignore-revs";

  if (!git("ls-tree", "--format=%(objectname)", commit.parent, "--", path)) return [];
  const contents = git("show", `${commit.parent}:${path}`);

  // Older versions of the list may name commits that no longer exist (e.g. pre-squash SHAs); blame rejects those.
  return [...contents.matchAll(/^([a-f0-9]{40})[ \t]*(?:#.*)?$/gm)].flatMap((match) =>
    commitExists(match[1]!, git) ? ["--ignore-rev", match[1]!] : [],
  );
}

function commitExists(sha: string, git: GitReader): boolean {
  try {
    return git("rev-parse", "--verify", "--quiet", `${sha}^{commit}`).trim() === sha;
  } catch {
    return false;
  }
}

function preimageRanges(diff: string): PreimageRange[] {
  return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)].map((match) => {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);

    // A zero-length preimage inserts AFTER start. At BOF only line 1 exists; blame clamps the end at EOF.
    return count === 0
      ? { start: Math.max(1, start), end: start + 1, kind: "adjacent" }
      : { start, end: start + count - 1, kind: "changed" };
  });
}

function blameRange(
  commit: PromotionCommit,
  file: string,
  range: PreimageRange,
  git: GitReader,
  ignored: string[],
): PromotionAttribution[] {
  const output = git(
    "blame",
    "--porcelain",
    "-w",
    "-M",
    "-C",
    ...ignored,
    "-L",
    `${range.start},${range.end}`,
    commit.parent,
    "--",
    file,
  );

  const owners = new Map<string, number[]>();

  for (const match of output.matchAll(/^([a-f0-9]{40}) \d+ (\d+)(?: \d+)?$/gm)) {
    const sha = match[1]!;
    const lines = owners.get(sha) ?? [];
    lines.push(Number(match[2]));
    owners.set(sha, lines);
  }

  // Insertion context must agree. Never pick one side merely because the other side was already released.
  if (range.kind === "adjacent" && owners.size !== 1) return [];

  return [...owners].map(([sha, lines]) => ({ sha, file, lines, kind: range.kind }));
}

export function attributePromotionFix(commit: PromotionCommit, git: GitReader): PromotionAttribution[] {
  const links = promotionCommitLinks(commit);

  if (!isPromotionFollowup(commit) || links.prs.length || links.shas.length) return [];
  const result: PromotionAttribution[] = [];
  const ignored = ignoredRevisions(commit, git);

  for (const file of commit.files) {
    if (sharedPromotionFile(file)) continue;
    const path = `:(literal)${file}`;

    const diff = git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "-w",
      "--ignore-blank-lines",
      "--inter-hunk-context=0",
      "-U0",
      commit.parent,
      commit.sha,
      "--",
      path,
    );

    const ranges = preimageRanges(diff);

    if (!ranges.length) continue;

    const blob = git("ls-tree", "--format=%(objecttype) %(objectname)", commit.parent, "--", path).match(
      /^blob ([a-f0-9]{40})$/,
    )?.[1];

    // New files and empty preimages have no adjacent context to attribute.
    if (!blob || git("cat-file", "-s", blob) === "0") continue;

    for (const range of ranges) result.push(...blameRange(commit, file, range, git, ignored));
  }

  return result;
}
