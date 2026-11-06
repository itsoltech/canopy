import { expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { ImportScanSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { CommandError } from "../runtime/host-types.ts";
import { installFixtureHome } from "./fixtures/install.ts";
import { READABLE_URL_PROSE, URL_BOUNDARIES } from "./fixtures/url-boundaries.ts";
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
  maskText("https:docs ".repeat(10_000), masker);
  const elapsed = performance.now() - started;

  // Two passes over 1 MiB; the regular expressions this replaced took seconds.
  expect(elapsed).toBeLessThan(1500);
});

test("a credential stored with its scheme or quotes is masked bare too", async () => {
  const { credentialForms } = await import("./masking.ts");
  const token = "bare-token-CANARY-0042-abcdef";
  const basic = Buffer.from("deploy:basic-password-CANARY-77").toString("base64");
  const masker = new Masker([`Bearer ${token}`, `"token ${token}"`, `Basic ${basic}`].flatMap(credentialForms));

  expect(maskText(`curl -H "x: ${token}"`, masker)).not.toContain("CANARY");
  expect(maskText(`login deploy basic-password-CANARY-77`, masker)).not.toContain("CANARY");
});

test("Basic credentials with an empty user mask the decoded password too", async () => {
  const { credentialForms } = await import("./masking.ts");
  const password = "empty-user-password-CANARY-0042";
  const masker = new Masker(credentialForms(`Basic ${Buffer.from(`:${password}`).toString("base64")}`));
  expect(maskText(`password ${password} and :${password}`, masker)).not.toContain(password);
  expect(maskText("short", new Masker(credentialForms(`Basic ${Buffer.from(":short").toString("base64")}`)))).toBe(
    "short",
  );
});

test("URL masking checks canonical authorities and decoded parameter names and values", () => {
  const secret = "url-fixture-CANARY-0042";
  const masker = new Masker([]);

  const urls = [
    `https://example.test/?%74oken=${secret}`,
    `https:/deploy:${secret}@example.test/repo`,
    `https:deploy:${secret}@example.test/repo`,
    `https:\\deploy:${secret}@example.test\\repo`,
    `https://deploy:${"x".repeat(600)}${secret}@example.test/repo`,
    `https:/example.test/?%74oken=${secret}`,
    `https:example.test/?%74oken=${secret}`,
    `https://example.test/#%61uth=${secret}`,
    `https://deploy:${secret}@[broken/repo`,
    `git+ssh://deploy:${secret}@example.test/repo`,
    `${secret}@example.test:org/repo`,
    `https://deploy:\t${secret}@example.test/repo`,
    `url:https://deploy:${secret}@example.test/repo`,
  ];

  for (const url of urls) {
    const masked = maskText(url, masker);
    expect(masked.includes("CANARY")).toBe(false);
    expect(masked.includes("%75rl-fixture")).toBe(false);
  }

  expect(maskText("git@example.test:org/repo", masker)).toBe("git@example.test:org/repo");
  expect(maskText("ssh://git@example.test/org/repo", masker)).toBe("ssh://git@example.test/org/repo");
  const encoded = `https://example.test/?value=${secret.replace("u", "%75")}`;
  expect(maskText(encoded, new Masker([secret])).includes("CANARY")).toBe(false);
  const encodedName = `https://example.test/?${secret.replace("u", "%75")}=plain`;
  expect(maskText(encodedName, new Masker([secret])).includes("CANARY")).toBe(false);
});

test("unparseable URLs fail closed on credentials without treating a git repository name as a parameter", async () => {
  const { inspectImportUrl } = await import("@canopy/domain/import-url");
  expect(inspectImportUrl("fixture/token-tools").credential).toBe(false);
  expect(inspectImportUrl("https://[broken/?%74oken=synthetic-canary").credential).toBe(true);
  expect(inspectImportUrl("https://deploy:synthetic-canary@[broken/").credential).toBe(true);
});

test("userinfo token delimiters cannot leak through prose, Markdown, code or JSON", () => {
  const masker = new Masker([]);

  for (const separator of [" ", '"', "'", "`", "\u00a0", "\u2003", "%20"]) {
    const url = `https://deploy:boundary${separator}CANARY-0042@example.test/repo`;
    expect(new URL(url).password.length).toBeGreaterThan(0);

    for (const text of [url, `[repository](${url})`, `\`${url}\``, JSON.stringify({ source: url }), `Use ${url} now`]) {
      expect(maskText(text, masker).includes("CANARY")).toBe(false);
    }
  }

  expect(maskText('https://deploy:boundary "CANARY-0042@[broken/repo', masker).includes("CANARY")).toBe(false);
  expect(maskText("https://deploy:CANARY-0042 https:part@example.test/repo", masker).includes("CANARY")).toBe(false);
});

test("URL parameter decoding is bounded and ambiguous encodings fail closed", async () => {
  const { inspectImportUrl } = await import("@canopy/domain/import-url");
  const secret = "nested-parameter-CANARY-0042";

  for (const parameter of [
    `%2574oken=${secret}`,
    `%252574oken=${secret}`,
    `%252525252574oken=${secret}`,
    `to%ZZken=${secret}`,
    `to%25ZZken=${secret}`,
    `to%FFken=${secret}`,
    `plain=%252525252541${secret}`,
    `plain=%25ZZ${secret}`,
  ]) {
    const url = `https://example.test/repo?${parameter}`;
    expect(inspectImportUrl(url).credential).toBe(true);
    expect(maskText(url, new Masker([])).includes("CANARY")).toBe(false);
  }

  const encoded = encodeURIComponent(secret.replace("n", "%6e"));
  const url = `https://example.test/?plain=${encoded}`;
  expect(maskText(url, new Masker([secret])).includes("CANARY")).toBe(false);
});

test("conservative authority and value boundaries protect credentials while prose stays readable", async () => {
  const { inspectImportUrl } = await import("@canopy/domain/import-url");
  const masker = new Masker([]);

  for (const [index, url] of URL_BOUNDARIES.entries()) {
    expect(inspectImportUrl(url).credential).toBe(true);

    for (const text of [url, `[repository](${url})`, `\`${url}\``, JSON.stringify({ url })]) {
      const masked = maskText(text, masker);
      expect(masked.includes("CANARY"), `boundary case ${index}`).toBe(false);
      expect(masked).not.toBe(text);
    }
  }

  expect(maskText(READABLE_URL_PROSE, masker)).toBe(READABLE_URL_PROSE);
});

test("documentation URLs stay intact while whole credential-name tokens are masked", async () => {
  const { inspectImportUrl } = await import("@canopy/domain/import-url");
  const masker = new Masker([]);

  for (const suffix of [
    "#authentication",
    "#code-quality",
    "#signature",
    "?design=compact",
    "?%2564esign=compact%20view",
    "?monkey=banana",
    "?keyboard=shortcuts",
    "?section=authentication",
    "#section=code-quality",
  ]) {
    const url = `https://example.test/docs${suffix}`;
    expect(inspectImportUrl(url).credential).toBe(false);
    expect(maskText(url, masker)).toBe(url);
  }

  for (const name of [
    "token",
    "tOkEn",
    "access_token",
    "api_key",
    "x-api-key",
    "client.secret",
    "password",
    "sig",
    "signature",
    "accessToken",
    "APIKey",
    "apikey",
    "code",
    "cOdE",
  ]) {
    const url = `https://example.test/?${name}=opaqueCANARY0042`;
    expect(inspectImportUrl(url).credential).toBe(true);
    expect(maskText(url, masker).includes("CANARY")).toBe(false);
  }
});

test("credentials in URLs are masked wherever a URL appears: user info and credential-like parameters", () => {
  const masker = new Masker([]);

  const masked = maskText(
    "git clone https://deploy:CANARYpass@git.example.test/r.git && curl 'https://api.example.test/v1?access_token=CANARYtok&page=2#sig=CANARYsig'",
    masker,
  );

  expect(masked).not.toContain("CANARY");
  // The rest of the URL stays readable.
  expect(masked).toContain("git.example.test/r.git");
  expect(masked).toContain("page=2");
  expect(maskText("https://example.test/docs?page=2&lang=en", masker)).toBe("https://example.test/docs?page=2&lang=en");
});
