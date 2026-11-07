import { expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { ImportScanSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { CommandError } from "../runtime/host-types.ts";
import { installFixtureHome } from "./fixtures/install.ts";
import { HIDDEN, MASK, Masker, maskText, MAX_SECRETS } from "./masking.ts";
import { WorkerImport } from "./service.ts";

/** Security tests for masking (docs/import.md, "Maskowanie"): equivalent encodings, scan titles, adversarial cost. */

const temp = tempDirs();

/** A known secret with a quote, a backslash and a character outside the BMP: every JSON escape applies to it. */
const SECRET = 'pa"ss\\word-CANARY-0042-😀-end';

/** The same secret as JSON text can write it: escaped once or twice, with `\uXXXX` for some or all of it. */
function encodings(secret: string): string[] {
  const once = JSON.stringify(secret).slice(1, -1);
  const twice = JSON.stringify(once).slice(1, -1);
  const unicode = [...secret].map((c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));

  const pairs = [...secret]
    .map((c) =>
      c.length > 1
        ? c
            .split("")
            .map((u) => `\\u${u.charCodeAt(0).toString(16)}`)
            .join("")
        : c === '"'
          ? '\\"'
          : c === "\\"
            ? "\\\\"
            : c,
    )
    .join("");

  return [
    secret,
    once,
    twice,
    unicode.join(""),
    JSON.stringify(unicode.join("")).slice(1, -1),
    pairs,
    once.replace('\\"', "\\u0022"),
    twice.replace('\\\\\\"', "\\\\\\u0022"),
    once.replace("/", "\\/"),
  ];
}

test("a known secret is masked in every JSON encoding, inside commands and diffs", () => {
  const masker = new Masker([SECRET]);

  for (const form of encodings(SECRET)) {
    for (const text of [
      form,
      `curl -H 'Authorization: ${form}' https://example.test`,
      `--- a/.env\n+++ b/.env\n-TOKEN=old\n+TOKEN="${form}"\n`,
      JSON.stringify({ cmd: `echo "${form}"` }),
      `{"input":"{\\"command\\":\\"echo ${form}\\"}"}`,
    ]) {
      const masked = maskText(text, masker);

      expect(masked).not.toContain("CANARY");
      expect(masked.includes(MASK) || masked.includes(HIDDEN)).toBe(true);
    }
  }
});

test("a secret found only after decoding hides the whole field", () => {
  const masker = new Masker([SECRET]);
  const encoded = `run ${JSON.stringify(SECRET).slice(1, -1).replace('\\"', "\\u0022")} now`;

  expect(maskText(encoded, masker)).toBe(HIDDEN);
  // A token format behind an escape, too.
  expect(maskText("key=\\u0073k-ant-api03-CANARYcanaryCANARYcanary0123456789", masker)).toBe(HIDDEN);
  // Plain text with escapes and no secret stays.
  expect(maskText('say \\"hello\\" and \\u0041', masker)).toBe('say \\"hello\\" and \\u0041');
});

test("a private key without its end marker is masked to the end of the field", () => {
  const masker = new Masker([]);
  const text = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA-CANARY\n";

  expect(maskText(text, masker)).toBe(`before\n${MASK}`);
  expect(maskText("a -----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY----- b", masker)).toBe(`a ${MASK} b`);
});

test("more known secret values than the masker holds fail the command and name none of them", () => {
  const values = Array.from({ length: MAX_SECRETS + 1 }, (_, i) => `value-CANARY-${i.toString().padStart(8, "0")}`);
  let error: unknown;

  try {
    new Masker(values);
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(CommandError);
  expect(error instanceof CommandError && error.code).toBe("IMPORT_TOO_MANY_SECRETS");
  expect(String(error instanceof Error && error.message)).not.toContain("CANARY");
  expect(() => new Masker(values.slice(0, MAX_SECRETS))).not.toThrow();
});

test("scan titles and previews are masked before whitespace is joined, in all three CLIs", async () => {
  const root = temp("canopy-import-masking-");
  const home = join(root, "home");
  installFixtureHome(home);
  // A known value with a tab and a double space: joining whitespace first would change it and miss it.
  const spaced = "tab\tand  space-CANARY-0077";
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { A: SECRET, B: spaced } }));
  const escaped = JSON.stringify(SECRET).slice(1, -1);
  const prompt = `deploy "${escaped}" and ${spaced}`;
  const project = join(home, ".claude", "projects", home.replace(/[^a-zA-Z0-9]/g, "-") + "-project");
  const claude = crypto.randomUUID();
  const base = { sessionId: claude, cwd: join(home, "project"), timestamp: new Date().toISOString() };

  writeFileSync(
    join(project, `${claude}.jsonl`),
    [
      { ...base, type: "user", uuid: "u1", message: { role: "user", content: prompt } },
      { type: "custom-title", sessionId: claude, customTitle: `title ${spaced}` },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );

  const rollouts = join(home, ".codex", "sessions", "2026", "11", "06");
  const rollout = readdirSync(rollouts)[0]!;
  const codexId = rollout.slice(-"01a1b2ac-583b-7822-987f-8c41cbb77f32.jsonl".length, -".jsonl".length);
  writeFileSync(
    join(home, ".codex", "session_index.jsonl"),
    `${JSON.stringify({ id: codexId, thread_name: `fix ${spaced} ${escaped}` })}\n`,
  );

  const grokProject = join(home, ".grok", "sessions", encodeURIComponent(join(home, "project")));
  const grokSession = readdirSync(grokProject, { withFileTypes: true }).find((d) => d.isDirectory())!.name;
  writeFileSync(join(grokProject, grokSession, "summary.json"), JSON.stringify({ generated_title: `x ${spaced}` }));

  const service = new WorkerImport({
    dataDir: join(root, "data"),
    homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
    config: () => undefined,
  });

  const scan = await service.scan([]);
  const planted = scan.threads!.find((t) => t.nativeId === claude)!;

  expect(planted.preview).not.toContain("CANARY");
  expect(planted.title).not.toContain("CANARY");
  expect(planted.title).toContain(MASK);
  expect(planted.flaggedSecrets).toBeGreaterThanOrEqual(2);
  expect(scan.threads!.find((t) => t.nativeId === codexId)!.title).not.toContain("CANARY");
  expect(scan.threads!.find((t) => t.nativeId === grokSession)!.title).toBe(`x ${MASK}`);
  expect(toJsonString(ImportScanSchema, create(ImportScanSchema, scan))).not.toContain("CANARY");
});

test("adversarial text costs linear time: 1 MiB of unclosed markers and token prefixes, many known values", () => {
  const values = Array.from({ length: MAX_SECRETS }, (_, i) => `known-value-${i.toString(36).padStart(12, "x")}-tail`);
  const masker = new Masker(values);

  // Unclosed key markers, token prefixes one character short of a match, dotted runs shaped like JWTs, escapes.
  const unit = [
    "-----BEGIN RSA PRIVATE KEY-----",
    `sk-proj-${"a".repeat(31)}`,
    `github_pat_${"b".repeat(39)}`,
    `eyJ${"c".repeat(12)}.eyJ${"d".repeat(12)}.${"e".repeat(9)}`,
    "known-value-xxxx",
    "\\u0041\\\\ ",
  ].join(" ");

  const text = unit.repeat(Math.ceil(1024 ** 2 / unit.length));
  const started = performance.now();

  maskText(text, masker);
  maskText(text.replaceAll("BEGIN", "END"), masker);
  const elapsed = performance.now() - started;

  // Two passes over 1 MiB; the regular expressions this replaced took seconds.
  expect(elapsed).toBeLessThan(1500);
});
