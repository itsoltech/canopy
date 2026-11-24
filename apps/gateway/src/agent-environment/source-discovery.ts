import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import {
  checkSkillPath,
  InvalidSkillDocumentError,
  InvalidSkillYamlError,
  readSkillMetadata,
  SKILL_FILE_COUNT,
  SKILL_TOTAL_BYTES,
  validateSkillFiles,
} from "@canopy/domain/skill-artifact";
import { Schema } from "effect";
import { sourceInvalid, type parseSourceCommand } from "./source-command.ts";
import { gitFile, readGitSource, type SourceTransport, type GitEntry } from "./source-git.ts";
import type { WebsiteTransport } from "./source-https.ts";
import { sourcePreview, visibleSourceSkill } from "./source-preview.ts";
import { probeWebsite, readWebsiteSource } from "./source-website.ts";

export interface SourceOptions extends SourceTransport, WebsiteTransport {
  /** Test registry uses loopback. Production is fixed to https://skills.sh; never supplied by an RPC. */
  registryBaseUrl?: string;
}

const Catalog = Schema.Struct({ skills: Schema.Array(Schema.Struct({ name: Schema.String, source: Schema.String })) });
const Containers = Schema.Struct({ paths: Schema.optional(Schema.Array(Schema.String)) });

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

  // A previously stored Git source keeps using Git even if its website adds a skill index later.
  if (parsed.source.wellKnown || (originalCommand && probeWebsite(parsed.source))) {
    const preview = await readWebsiteSource(parsed, options);

    if (preview) return preview;
  }

  const namedSelection = parsed.names.length > 0 && !parsed.names.includes("*");

  return readGitSource(
    parsed.source,
    authorization,
    options,
    async (commit, entries, blobs) => {
      const licenseFile = entries.find((e) => /^(LICENSE|LICENCE|COPYING)(\.(txt|md))?$/i.test(e.path));
      const byPath = new Map(entries.map((entry) => [entry.path, entry]));
      const checkedRoots = new Set<string>();
      const selected = new Map<string, { marker: GitEntry; content: Buffer }>();
      const names = new Set<string>();
      const invalidYaml: string[] = [];
      let markerBytes = 0;

      const readMarkers = async (fullDepth: boolean, extra: GitEntry[]) => {
        const roots = await discoveryRoots(entries, blobs.read, parsed.source.path, fullDepth);

        const markers = roots
          .filter((root) => !checkedRoots.has(root))
          .map((root) => ({ root, marker: byPath.get(root ? `${root}/SKILL.md` : "SKILL.md")! }));

        await blobs.prepare([...markers.map(({ marker }) => marker), ...extra]);

        for (const { root, marker } of markers) {
          checkedRoots.add(root);
          markerBytes += blobs.size(marker);

          if (markerBytes > SKILL_TOTAL_BYTES)
            sourceInvalid("Skill discovery exceeds 25 MiB of SKILL.md files. Select a skill folder.");
          const content = await blobs.read(marker);
          let name;

          try {
            name = readSkillMetadata(content).name;
          } catch (cause) {
            if (cause instanceof InvalidSkillYamlError) invalidYaml.push(marker.path);
            else if (!namedSelection || !(cause instanceof InvalidSkillDocumentError)) throw cause;
            continue;
          }

          if (namedSelection ? !parsed.names.includes(name) : !visibleSourceSkill(content, name, parsed.names))
            continue;

          if (names.has(name)) sourceInvalid("Multiple skills have the same name. Select a specific skill folder.");

          if (selected.size >= 100)
            sourceInvalid("A source preview supports at most 100 skills. Use --skill to select fewer.");
          names.add(name);
          selected.set(root, { marker, content });
        }
      };

      const missingNames = () => parsed.names.some((name) => name !== "*" && !names.has(name));
      await readMarkers(parsed.fullDepth, licenseFile ? [licenseFile] : []);

      if (namedSelection && !parsed.fullDepth && missingNames()) await readMarkers(true, []);

      const [firstInvalid] = invalidYaml;

      const yamlNotice = firstInvalid
        ? invalidYaml.length === 1
          ? `Skipped “${firstInvalid}” because it contains invalid YAML. Fix the file in the repository, then retry.`
          : `Skipped ${invalidYaml.length} skill files with invalid YAML, including “${firstInvalid}”. Fix the files in the repository, then retry.`
        : "";

      if (missingNames())
        sourceInvalid("Could not find every requested skill. Check the --skill names and source path.");

      if (!selected.size) sourceInvalid(yamlNotice || "No matching skills found. Check the path and --skill names.");

      const skills: ui.ResolvedSourceSkill[] = [];
      let total = 0;

      for (const [root, { marker, content }] of selected) {
        const skillEntries = entries.filter((entry) => under(entry.path, root));

        if (skillEntries.length > SKILL_FILE_COUNT)
          sourceInvalid("A selected skill exceeds 1000 files. Select a smaller skill folder.");

        for (const entry of skillEntries) checkSkillPath(entry.path);
        await blobs.prepare(skillEntries);
        const files = [];

        for (const entry of skillEntries) {
          total += blobs.size(entry);

          if (total > SKILL_TOTAL_BYTES)
            sourceInvalid("The selected skills exceed 25 MiB. Use --skill to select fewer.");
          files.push(gitFile(entry, entry === marker ? content : await blobs.read(entry), root));
        }

        skills.push(create(ui.ResolvedSourceSkillSchema, { path: root, artifact: validateSkillFiles(files) }));
      }

      const license =
        licenseFile && blobs.size(licenseFile) <= 64 * 1024
          ? new TextDecoder().decode(await blobs.read(licenseFile))
          : "No repository license file found in this snapshot.";

      const preview = sourcePreview(parsed, { ...parsed.source, commit }, skills, license);

      if (yamlNotice) preview.notices.push(yamlNotice);

      return preview;
    },
    namedSelection || Boolean(parsed.source.path),
  );
}
