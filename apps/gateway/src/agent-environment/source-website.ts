import { create } from "@bufbuild/protobuf";
import { SkillFileSchema, ui } from "@canopy/contracts";
import {
  checkSkillPath,
  SKILL_FILE_BYTES,
  SKILL_FILE_COUNT,
  SKILL_TOTAL_BYTES,
  skillName,
  validateSkillFiles,
} from "@canopy/domain/skill-artifact";
import { Schema } from "effect";
import { sourceInvalid, type parseSourceCommand } from "./source-command.ts";
import { websiteReader, type WebsiteTransport } from "./source-https.ts";
import { sourcePreview, visibleSourceSkill } from "./source-preview.ts";

const Index = Schema.Struct({
  $schema: Schema.optional(Schema.Never),
  skills: Schema.Array(Schema.Struct({ name: Schema.String, files: Schema.Array(Schema.String) })),
});

export function probeWebsite(source: ui.SkillSource) {
  const url = new URL(source.url);

  return (
    !source.credentialAccountId &&
    source.ref === "HEAD" &&
    !source.path &&
    url.pathname === "/" &&
    !["github.com", "gitlab.com", "huggingface.co"].includes(url.hostname)
  );
}

function decodeIndex(content: Buffer) {
  try {
    return Schema.decodeUnknownSync(Index)(JSON.parse(content.toString("utf8"))).skills;
  } catch {
    return sourceInvalid("This website uses an unsupported skill catalog. Use a repository or upload a skill folder.");
  }
}

function checkWebsiteFiles(paths: readonly string[]) {
  if (paths.length > SKILL_FILE_COUNT || !paths.includes("SKILL.md"))
    sourceInvalid("Each skill needs a SKILL.md and at most 1000 files. Check the website's catalog.");
  const seen = new Set<string>();

  for (const path of paths) {
    try {
      checkSkillPath(path);
    } catch {
      sourceInvalid("A website skill lists an invalid file path. Check the website's catalog.");
    }

    const key = path.toLowerCase();

    if (seen.has(key)) sourceInvalid("A website skill lists duplicate files. Check the website's catalog.");
    seen.add(key);
  }
}

export async function readWebsiteSource(parsed: ReturnType<typeof parseSourceCommand>, transport: WebsiteTransport) {
  const read = await websiteReader(new URL(parsed.source.url), transport);
  const preferred = "/.well-known/agent-skills";
  const legacy = "/.well-known/skills";
  const primary = await read(`${preferred}/index.json`, SKILL_FILE_BYTES, true);
  const directory = primary ? preferred : legacy;
  const index = primary ?? (await read(`${legacy}/index.json`, SKILL_FILE_BYTES, true));

  if (!index) {
    if (parsed.source.wellKnown)
      sourceInvalid("This website no longer lists skills. Check the source URL and try again.");

    return undefined;
  }

  const names = parsed.source.path ? [parsed.source.path] : parsed.names;
  const candidates = decodeIndex(index).filter((s) => !names.length || names.includes("*") || names.includes(s.name));

  if (candidates.length > 100) sourceInvalid("A preview supports up to 100 skills. Use --skill to select fewer.");
  const skills: ui.ResolvedSourceSkill[] = [];
  let remaining = SKILL_TOTAL_BYTES;

  for (const { name, files: paths } of candidates) {
    if (!skillName(name)) sourceInvalid("The website lists an invalid skill name. Check the website's catalog.");
    checkSkillPath(name);
    checkWebsiteFiles(paths);
    const files = [];

    for (const path of paths) {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const content = await read(`${directory}/${name}/${encoded}`, Math.min(SKILL_FILE_BYTES, remaining));

      if (!content) sourceInvalid("A skill file is missing. Check the website's catalog.");
      remaining -= content.length;
      files.push(create(SkillFileSchema, { path, content }));
    }

    const artifact = validateSkillFiles(files);

    if (artifact.name !== name) sourceInvalid("The skill name changed. Check the website's catalog.");
    const entry = files.find((f) => f.path === "SKILL.md")!;

    if (!visibleSourceSkill(entry.content, name, names)) continue;

    if (skills.some((skill) => skill.path === name))
      sourceInvalid("The website lists duplicate skill names. Check the website's catalog.");
    skills.push(create(ui.ResolvedSourceSkillSchema, { path: name, artifact }));
  }

  if (!skills.length || names.some((n) => n !== "*" && !skills.some((s) => s.path === n)))
    sourceInvalid("No matching skills found on this website. Check the --skill names and try again.");

  return sourcePreview(
    parsed,
    {
      ...parsed.source,
      wellKnown: true,
      ref: "",
      commit: skills.length === 1 ? (skills[0]?.artifact?.checksum ?? "") : "",
    },
    skills,
    "",
  );
}
