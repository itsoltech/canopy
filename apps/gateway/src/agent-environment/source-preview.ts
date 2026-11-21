import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Schema } from "effect";
import type { parseSourceCommand } from "./source-command.ts";

const Metadata = Schema.Struct({
  metadata: Schema.optional(Schema.Struct({ internal: Schema.optional(Schema.Boolean) })),
});

/** Called after artifact validation, which requires frontmatter at the start of SKILL.md. */
export function visibleSourceSkill(content: Uint8Array, name: string, names: string[]) {
  const frontmatter = Buffer.from(content)
    .toString("utf8")
    .match(/^---\r?\n([\s\S]*?)\r?\n---/);

  const internal = Schema.decodeUnknownSync(Metadata)(Bun.YAML.parse(frontmatter![1]!)).metadata?.internal;

  return names.includes(name) || (!internal && (!names.length || names.includes("*")));
}

export function sourcePreview(
  parsed: ReturnType<typeof parseSourceCommand>,
  source: ui.SkillSource,
  skills: ui.ResolvedSourceSkill[],
  license: string,
) {
  return create(ui.SkillSourcePreviewSchema, {
    id: Bun.randomUUIDv7(),
    source,
    license,
    skills,
    harnesses: parsed.harnesses,
    deviceHome: parsed.deviceHome,
    notices: [
      ...parsed.notices,
      "Only skill directories are imported. Hooks, MCP, installers and plugin manifests outside them are not activated.",
    ],
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
}
