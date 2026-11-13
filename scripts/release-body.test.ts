import { expect, test } from "bun:test";
import { limitReleaseBody, RELEASE_BODY_LIMIT } from "./release-body.mjs";
import { generateReleaseNotes } from "./generate-release-notes.mjs";
import { parseReleaseBody } from "./release-notes.ts";
import { releaseIndex } from "./release-index.ts";
import { parseReleaseIndex } from "@canopy/domain/release/catalog";
import { githubRequest } from "./release-draft.mjs";

const compare = "https://github.com/itsoltech/canopy/compare/v0.1.0...v0.2.0-beta.1";

test("large ranges retain complete summaries, prioritize features/fixes and report the exact omitted count", () => {
  const bullets = (prefix: string, count: number) =>
    Array.from(
      { length: count },
      (_, i) =>
        `* **web:** ${prefix} ${i} ${"🌳".repeat(100)} (#${i + 1 + ["feat", "fix", "perf"].indexOf(prefix) * 500})`,
    ).join("\n");

  const original = `# [0.2.0-beta.1](${compare})\n\n### Performance Improvements\n${bullets("perf", 500)}\n### Bug Fixes\n${bullets("fix", 500)}\n### Features\n${bullets("feat", 500)}`;
  const body = limitReleaseBody(original);
  const entries = parseReleaseBody(body);
  expect(body.length).toBeLessThanOrEqual(RELEASE_BODY_LIMIT);
  expect(body).toBe(limitReleaseBody(original, compare));
  expect(body).toBe(limitReleaseBody(body, compare));
  expect(body).toContain(`… and ${1500 - entries.length} more changes`);
  expect(body).toContain(compare);
  const generatedByGithub = original.replace(`# [0.2.0-beta.1](${compare})`, `**Full Changelog**: ${compare}`);
  expect(limitReleaseBody(generatedByGithub).endsWith(`[Full changelog](${compare})\n`)).toBe(true);
  expect(entries[0]).toMatchObject({ type: "feat", scope: "web", pr: 1 });
  expect(entries.some((entry) => entry.type === "perf")).toBe(false);
  expect(entries.some((entry) => entry.type === "fix")).toBe(true);
  expect(body).not.toContain("�");
});

test("draft failures expose API validation details without dumping the request or child error", () => {
  const failure = Object.assign(new Error("Child failure with request details"), {
    stdout: JSON.stringify({
      message: "Validation Failed",
      errors: [
        {
          resource: "Release",
          field: "body",
          code: "too_long",
          message: "body is too long (maximum is 125000 characters)",
        },
      ],
    }),
    stderr: "gh: Validation Failed (HTTP 422)",
  });

  const run = () => {
    throw failure;
  };

  expect(() => githubRequest(["api"], { body: "Request content must stay private" }, run)).toThrow(
    "Validation Failed; Release: body: too_long: body is too long (maximum is 125000 characters)",
  );
  expect(() =>
    githubRequest(["api"], undefined, () => {
      throw Object.assign(new Error("Request details"), { stderr: "gh: HTTP 503" });
    }),
  ).toThrow("gh: HTTP 503");
});

test("a single enormous header and non-Angular prose cannot exceed the cap", () => {
  for (const body of [`### Features\n* ${"x".repeat(200_000)}`, "x".repeat(200_000)]) {
    const limited = limitReleaseBody(body, compare);
    expect(limited.length).toBeLessThanOrEqual(RELEASE_BODY_LIMIT);
    expect(limited).toContain(compare);
  }

  expect(limitReleaseBody("Existing notes")).toBe("Existing notes");
  expect(limitReleaseBody("x".repeat(200_000), "x".repeat(200_000)).length).toBeLessThanOrEqual(RELEASE_BODY_LIMIT);
});

test("generated headers keep the What's new parser contract without including PR bodies", async () => {
  const notes = await generateReleaseNotes(
    { preset: "angular" },
    {
      cwd: process.cwd(),
      commits: [
        {
          hash: "a".repeat(40),
          message: `fix(web): restore updates (#601)\n\nBREAKING CHANGE: ${"body".repeat(40_000)}`,
        },
        { hash: "b".repeat(40), message: "feat(web): show release notes (#600)\n\nPrivate implementation details" },
        { hash: "c".repeat(40), message: "perf(gateway): cache catalog (#602)" },
      ],
      lastRelease: { gitTag: "v0.1.0" },
      nextRelease: { version: "0.2.0-beta.1", gitTag: "v0.2.0-beta.1" },
      options: { repositoryUrl: "https://github.com/itsoltech/canopy.git" },
    },
  );

  expect(notes.length).toBeLessThan(RELEASE_BODY_LIMIT);
  expect(notes).not.toContain("Private implementation");
  expect(notes).not.toContain("bodybody");
  expect(notes).toContain(compare);
  expect(parseReleaseBody(notes).map(({ type, scope, pr }) => ({ type, scope, pr }))).toEqual([
    { type: "feat", scope: "web", pr: 600 },
    { type: "fix", scope: "web", pr: 601 },
    { type: "perf", scope: "gateway", pr: 602 },
  ]);
});

test("release-index bounds later edited release bodies before publishing the Pages snapshot", () => {
  const text = releaseIndex([
    {
      tag_name: "v0.2.0-beta.1",
      draft: false,
      prerelease: true,
      published_at: "2026-11-13T09:00:00Z",
      body: `### Features\n${Array.from({ length: 1000 }, (_, i) => `* ${i} ${"x".repeat(200)}`).join("\n")}`,
      assets: ["manifest.json", "checksums.txt"].map((name) => ({
        name,
        browser_download_url: `https://github.com/itsoltech/canopy/releases/download/v0.2.0-beta.1/${name}`,
        state: "uploaded",
      })),
    },
  ]);

  expect(parseReleaseIndex(text)[0]!.body!.length).toBeLessThanOrEqual(RELEASE_BODY_LIMIT);
});
