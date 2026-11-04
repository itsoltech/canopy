import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { checkSkillPath, SKILL_TOTAL_BYTES, validateSkillFiles } from "@canopy/domain/skill-artifact";
import { Schema } from "effect";
import { sourceInvalid, type parseSourceCommand } from "./source-command.ts";
import { gitFile, readGitSource, type SourceTransport, type GitEntry } from "./source-git.ts";

export interface SourceOptions extends SourceTransport {
  /** Test registry uses loopback. Production is fixed to https://skills.sh; never supplied by an RPC. */
  registryBaseUrl?: string;
}

const Catalog = Schema.Struct({ skills: Schema.Array(Schema.Struct({ name: Schema.String, source: Schema.String })) });
const Containers = Schema.Struct({ paths: Schema.optional(Schema.Array(Schema.String)) });

const Metadata = Schema.Struct({
  metadata: Schema.optional(Schema.Struct({ internal: Schema.optional(Schema.Boolean) })),
});

async function registryLink(command: string, options: SourceOptions): Promise<void> {
  const match = command.trim().match(/^https:\/\/skills\.sh\/([\w.-]+)\/([\w.-]+)\/([\w-]+)$/);

  if (!match) return;

  const response = await fetch(
    `${options.registryBaseUrl ?? "https://skills.sh"}/api/search?q=${encodeURIComponent(match[3]!)}`,
    {
      redirect: "error",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok || !response.body)
    throw new Error("Skill catalog is unavailable. Paste its repository reference instead.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const part = await reader.read();

      if (part.done) break;
      size += part.value.length;

      if (size > 1024 * 1024) sourceInvalid("Skill catalog response is too large.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }

  const catalog = Schema.decodeUnknownSync(Catalog)(JSON.parse(Buffer.concat(chunks).toString("utf8")));

  if (!catalog.skills.some((s) => s.source === `${match[1]}/${match[2]}` && s.name === match[3]))
    sourceInvalid("The catalog does not identify this skill. Paste its repository reference instead.");
}

const under = (path: string, root: string) => !root || path.startsWith(`${root}/`);

async function discoveryRoots(
  entries: GitEntry[],
  blob: (entry: GitEntry) => Promise<Uint8Array>,
  base: string,
  fullDepth: boolean,
) {
  const marker = base ? `${base}/SKILL.md` : "SKILL.md";

  if (!fullDepth && entries.some((e) => e.path === marker)) return [base];
  const containers = ["skills", "skills/.curated", "skills/.experimental", "skills/.system"];
  const config = entries.find((e) => e.path === (base ? `${base}/skills.sh.json` : "skills.sh.json"));

  if (config) {
    const parsed = Schema.decodeUnknownSync(Containers)(JSON.parse(Buffer.from(await blob(config)).toString("utf8")));

    for (const path of parsed.paths ?? []) {
      if (!path.startsWith("./")) sourceInvalid("skills.sh.json paths must start with ./ and stay in the repository.");
      const relative = path.slice(2).replace(/\/$/, "");
      checkSkillPath(relative);
      containers.push(relative);
    }
  }

  const roots = entries.flatMap((e) =>
    e.path === marker ? [base] : e.path.endsWith("/SKILL.md") && under(e.path, base) ? [e.path.slice(0, -9)] : [],
  );

  const candidates = roots.filter((root) => {
    const relative = root.slice(base ? base.length + 1 : 0);

    if (relative.split("/").some((p) => ["node_modules", ".git", "dist", "build", "__pycache__"].includes(p)))
      return false;

    return (
      relative.split("/").length <= 1 ||
      containers.some((c) => relative.startsWith(`${c}/`) && relative.slice(c.length + 1).split("/").length <= 3) ||
      /^\.[\w-]+\/skills\//.test(relative)
    );
  });

  const selected =
    fullDepth || !candidates.length ? roots.filter((r) => r.slice(base.length).split("/").length <= 6) : candidates;

  return [...new Set(selected)]
    .sort()
    .filter((root, _i, all) => fullDepth || !all.some((parent) => parent !== root && under(root, parent)));
}

export async function discoverSource(
  parsed: ReturnType<typeof parseSourceCommand>,
  authorization: string,
  options: SourceOptions,
  originalCommand = "",
) {
  await registryLink(originalCommand, options);

  return readGitSource(parsed.source, authorization, options, async (commit, entries, blob) => {
    const licenseFile = entries.find((e) => /^(LICENSE|LICENCE|COPYING)(\.(txt|md))?$/i.test(e.path));

    const license =
      licenseFile && licenseFile.size <= 64 * 1024
        ? new TextDecoder().decode(await blob(licenseFile))
        : "No repository license file found in this snapshot.";

    const roots = await discoveryRoots(entries, blob, parsed.source.path, parsed.fullDepth);
    const skills: ui.ResolvedSourceSkill[] = [];
    let total = 0;

    for (const root of roots) {
      const files = [];

      for (const entry of entries.filter((e) => under(e.path, root))) {
        total += entry.size;

        if (total > SKILL_TOTAL_BYTES) sourceInvalid("Preview artifacts are limited to 25 MiB in total.");
        files.push(gitFile(entry, await blob(entry), root));
      }

      const artifact = validateSkillFiles(files);
      const entry = files.find((f) => f.path === "SKILL.md")!;

      const metadata = Buffer.from(entry.content)
        .toString()
        .match(/^---\r?\n([\s\S]*?)\r?\n---/);

      const internal = Schema.decodeUnknownSync(Metadata)(Bun.YAML.parse(metadata![1]!)).metadata?.internal;
      const explicit = parsed.names.includes(artifact.name);

      if (internal && !explicit) continue;

      if (parsed.names.length && !parsed.names.includes("*") && !explicit) continue;

      if (skills.some((s) => s.artifact?.name === artifact.name))
        sourceInvalid("Ambiguous duplicate skill names. Select an explicit repository path.");
      skills.push(create(ui.ResolvedSourceSkillSchema, { path: root, artifact }));

      if (skills.length > 100) sourceInvalid("A source preview supports at most 100 skills.");
    }

    if (!skills.length || parsed.names.some((n) => n !== "*" && !skills.some((s) => s.artifact?.name === n)))
      sourceInvalid("No matching skills found. Check the path and --skill names.");

    return create(ui.SkillSourcePreviewSchema, {
      id: Bun.randomUUIDv7(),
      source: { ...parsed.source, commit },
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
  });
}
