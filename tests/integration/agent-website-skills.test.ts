import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { librarySkill, skillMachine } from "./support/agent-skills.ts";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";

const origin = "https://skills.example";
const directory = "/.well-known/skills";
const root = tempDir("canopy-website-skills-");
const requests: string[] = [];
const files = ["SKILL.md", "scripts/check.sh", "references/UI basics.md"];
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: Design interfaces.\n---\n${body}\n`;

const responses = new Map<string, string | Response>([
  [`${directory}/ui-design/SKILL.md`, skill("ui-design", "Reviewed version")],
  [`${directory}/ui-design/scripts/check.sh`, "#!/bin/sh\nprintf 'checked'\n"],
  [`${directory}/ui-design/references/UI%20basics.md`, "Review the layout."],
  [`${directory}/ui-radar/SKILL.md`, skill("ui-radar", "Related skill")],
]);

const catalog = () =>
  JSON.stringify({
    skills: [
      { name: "ui-design", files },
      { name: "ui-radar", files: ["SKILL.md"] },
    ],
  });

const previewCommand = `npx skills add ${origin} --skill ui-design`;

let server: ReturnType<typeof Bun.serve>;
let gateway: Awaited<ReturnType<typeof startTestGateway>>;
let machine: Awaited<ReturnType<typeof skillMachine>>;
const snapshot = () => gateway.api.getAgentEnvironment({});
const preview = (command = previewCommand) => gateway.api.previewSkillSource({ command });

beforeAll(async () => {
  responses.set(`${directory}/index.json`, catalog());
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      const response = responses.get(path);

      return response instanceof Response ? response.clone() : new Response(response, { status: response ? 200 : 404 });
    },
  });
  gateway = await startTestGateway({
    skillSources: { fixtureWebsite: (candidate) => (candidate === origin ? server.url : undefined) },
  });
  machine = await skillMachine(gateway, root, "website-skill-computer");
  await eventually(snapshot, (s) => s.workers.some((w) => w.workerId === machine.workerId && w.skillsSupported));
}, 60_000);

afterAll(async () => {
  try {
    if (machine) {
      machine.link.close();
      await machine.serving;
      await machine.host.close();
      await machine.runtime.dispose();
    }
  } finally {
    server?.stop(true);

    if (gateway) await gateway.close();
  }
}, 30_000);

test("website command previews a selected skill and installs the reviewed files before checking upstream", async () => {
  const before = await snapshot();
  const resolved = await preview();
  expect(requests).toEqual([
    "/.well-known/agent-skills/index.json",
    `${directory}/index.json`,
    `${directory}/ui-design/SKILL.md`,
    `${directory}/ui-design/scripts/check.sh`,
    `${directory}/ui-design/references/UI%20basics.md`,
  ]);
  expect(resolved.skills.map((entry) => entry.path)).toEqual(["ui-design"]);
  expect(resolved.source).toMatchObject({ wellKnown: true, url: `${origin}/`, ref: "" });
  expect((await snapshot()).revision).toBe(before.revision);

  // Import a multi-skill preview and confirm its versions each track their own files.
  const multi = await preview(origin);
  expect(multi.skills.map((entry) => entry.path)).toEqual(["ui-design", "ui-radar"]);
  responses.set(`${directory}/ui-design/SKILL.md`, skill("ui-design", "Updated version"));

  const added = await gateway.api.addSkillSource({
    previewId: multi.id,
    paths: multi.skills.map((entry) => entry.path),
    assignment: librarySkill(),
    expectedRevision: before.revision,
  });

  const design = added.skills.find((entry) => entry.name === "ui-design")!;
  const radar = added.skills.find((entry) => entry.name === "ui-radar")!;

  const installed = async (text: string) => {
    await eventually(snapshot, (s) => {
      const report = s.workers.find((w) => w.workerId === machine.workerId)?.report;

      return (
        report?.revision === s.revision && report.skills.some((f) => f.skillId === design.id && f.status === "applied")
      );
    });
    expect(readFileSync(join(machine.dataDir, "codex-home/skills/ui-design/SKILL.md"), "utf8")).toContain(text);
    expect(readFileSync(join(machine.dataDir, "codex-home/skills/ui-design/references/UI basics.md"), "utf8")).toBe(
      "Review the layout.",
    );
  };

  await installed("Reviewed version");
  expect(design.source?.commit).toBe(resolved.source?.commit);
  expect(design.source?.autoUpdate).toBe(false);
  expect((await gateway.api.checkSkillSource({ id: radar.id })).source?.commit).toBe(radar.source?.commit);
  const update = await gateway.api.checkSkillSource({ id: design.id });
  expect(update.source?.commit).not.toBe(design.source?.commit);
  await gateway.api.applySkillSource({
    id: design.id,
    previewId: update.id,
    expectedRevision: (await snapshot()).revision,
  });
  await installed("Updated version");
}, 30_000);

test("website imports reject private addresses, traversal, redirects and oversized downloads", async () => {
  const before = await snapshot();
  expect(await failure(preview("https://127.0.0.1/"))).toContain("public addresses");
  const preferred = "/.well-known/agent-skills";
  responses.set(
    `${preferred}/index.json`,
    JSON.stringify({ skills: [{ name: "ui-design", files: ["SKILL.md", "../secret"] }] }),
  );
  requests.length = 0;
  expect(await failure(preview())).toContain("invalid file path");
  expect(requests).toEqual([`${preferred}/index.json`]);

  responses.set(`${preferred}/index.json`, JSON.stringify({ skills: [{ name: "ui-design", files: ["SKILL.md"] }] }));
  const path = `${preferred}/ui-design/SKILL.md`;
  responses.set(path, Response.redirect(`${server.url.origin}/unexpected`));
  expect(await failure(preview())).toContain("Could not download");
  expect(requests).not.toContain("/unexpected");

  responses.set(path, "A".repeat(1024 * 1024 + 1));
  expect(await failure(preview())).toContain("size limit");
  expect((await snapshot()).revision).toBe(before.revision);
});
