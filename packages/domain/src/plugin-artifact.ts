import { create } from "@bufbuild/protobuf";
import { SkillArtifactSchema, type SkillFile } from "@canopy/contracts";
import { Schema } from "effect";
import {
  skillManifestDigest,
  skillName,
  validateArtifactFiles,
  SKILL_FILE_COUNT,
  SKILL_TOTAL_BYTES,
} from "./skill-artifact.ts";

export const PLUGIN_MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];
const Manifest = Schema.Struct({ name: Schema.String, description: Schema.optionalKey(Schema.String) });

/** A plugin is code. Every version, including data-only bundles, requires digest-bound owner consent. */
export function validatePluginFiles(input: readonly SkillFile[], { managedCatalog = false } = {}) {
  const files = validateArtifactFiles(input);

  if (files.some((f) => f.path === ".in_use" || f.path.startsWith(".in_use/")))
    throw new Error("The .in_use cache marker is reserved for the harness.");

  if (
    !managedCatalog &&
    (files.length >= SKILL_FILE_COUNT ||
      files.reduce((sum, f) => sum + f.content.length, 0) > SKILL_TOTAL_BYTES - 1024 ||
      files.some((f) => [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"].includes(f.path)))
  )
    throw new Error(
      "Plugin bundles reserve one file and 1 KiB for the managed catalog and cannot contain nested marketplaces.",
    );
  const manifests = files.filter((f) => PLUGIN_MANIFESTS.includes(f.path));

  if (!manifests.length) throw new Error("The plugin needs a Claude or Codex plugin.json manifest.");

  const decoded = manifests.map((f) =>
    Schema.decodeUnknownSync(Manifest)(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(f.content))),
  );

  const manifest = decoded[0]!;

  if (!skillName(manifest.name) || decoded.some((m) => m.name !== manifest.name))
    throw new Error("Plugin manifests must have the same portable lowercase name.");

  for (const file of manifests) {
    const metadata = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(Buffer.from(file.content).toString()));

    if (metadata["dependencies"] || metadata["requiresPlugins"])
      throw new Error("Plugins with automatic plugin dependencies are not supported. Review dependencies separately.");
  }

  return create(SkillArtifactSchema, {
    name: manifest.name,
    description: manifest.description?.slice(0, 1024) ?? "",
    files,
    checksum: skillManifestDigest(files),
  });
}
