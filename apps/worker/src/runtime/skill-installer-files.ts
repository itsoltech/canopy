import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { SkillArtifact } from "@canopy/contracts";
import { withSkillDirectory, type SkillDirectory, type SkillEntry } from "../agent-environment/skill-directory.ts";
import { captureSkillDirectory } from "../agent-environment/skill-preview.ts";
import { deviceSkillInventoryRoots } from "../agent-environment/skill-targets.ts";
import type { EnvironmentHomes } from "../agent-environment/targets.ts";
import { deviceClaudeHome } from "../providers/claude/home.ts";
import { deviceCodexHome } from "../providers/codex/home.ts";

const skillDocument = "SKILL.md";
const maxCandidates = 32;
const maxHints = 256;
const maxScanEntries = 2048;

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);

  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function markerVersion(marker: SkillEntry): string {
  return `${marker.identity}:${marker.version}:${marker.changed}`;
}

function inventory(root: string): Map<string, string> | undefined {
  try {
    return (
      withSkillDirectory(root, (directory) => {
        const skills = new Map<string, string>();

        for (const name of directory.names(maxScanEntries)) {
          if (directory.entry(name)?.kind !== "directory") continue;
          const child = directory.child(name);

          try {
            const marker = child.entry(skillDocument);

            if (marker?.kind === "file") skills.set(child.path, markerVersion(marker));
          } finally {
            child.close();
          }
        }

        return skills;
      }) ?? new Map()
    );
  } catch {
    // A denied or oversized root is ineligible for the fallback. Explicit terminal hints may still be available.
    return undefined;
  }
}

function* terminalHints(output: Uint8Array): Iterable<string> {
  for (const line of stripVTControlCharacters(Buffer.from(output).toString("utf8")).split(/[\r\n]/)) {
    // Keep spaces in each unquoted path. Quote and arrow markers are common in installer summaries.
    for (const quoted of line.matchAll(/(["'`])([^"'`]+)\1/g)) yield quoted[2] ?? "";
    const destination = line.split(/(?:→|➜|⇒|⟶|->|=>)\s*/).at(-1);

    if (destination && destination !== line) yield destination;

    const path = /(?:^|\s)((?:~\/|\.\/|\/).+)$/.exec(line);

    if (path?.[1]) yield path[1];
  }
}

function scanWorkDir(cwd: string, remember: (path: string) => void): void {
  let visited = 0;

  const scan = (directory: SkillDirectory, depth: number) => {
    if (directory.entry(skillDocument)?.kind === "file") {
      remember(directory.path);

      return;
    }

    if (depth >= 7) return;

    for (const name of directory.names(maxScanEntries - visited)) {
      visited++;

      if (name === ".git" || name === "node_modules" || directory.entry(name)?.kind !== "directory") continue;
      const child = directory.child(name);

      try {
        scan(child, depth + 1);
      } finally {
        child.close();
      }
    }
  };

  try {
    withSkillDirectory(cwd, (directory) => scan(directory, 0));
  } catch {
    // Keep validated hints and the directories found before an unreadable or oversized subtree.
  }
}

export class SkillInstallerFiles {
  readonly #roots: Map<string, Map<string, string> | undefined>;
  readonly #home: string;
  readonly #found = new Map<string, () => SkillArtifact>();

  constructor(
    readonly cwd: string,
    readonly home: string,
    deviceHomes: EnvironmentHomes["deviceHomes"],
  ) {
    // Canonicalize the device home itself (for example a macOS /var alias), never a candidate or a skill root.
    this.#home = realpathSync(home);

    const defaults = deviceSkillInventoryRoots({
      deviceHomes: { claude: deviceClaudeHome({}, this.#home), codex: deviceCodexHome({}, this.#home) },
    });

    const configured = deviceSkillInventoryRoots({ deviceHomes });
    this.#roots = new Map();

    for (const root of [...defaults.keys(), ...configured.keys()]) {
      if (!isAbsolute(root)) continue;
      const path = this.#resolveHomeAlias(resolve(root));

      if (!this.#roots.has(path)) this.#roots.set(path, inventory(path));
    }
  }

  discover(output: Uint8Array): string[] {
    const examined = new Set<string>();

    for (const hint of terminalHints(output)) {
      if (this.#found.size >= maxCandidates || examined.size >= maxHints) break;
      const path = hint.trim().replace(/^(["'`])(.+)\1$/, "$2");

      if (!path || path.length > 4096 || path.includes("\0") || examined.has(path)) continue;
      examined.add(path);
      const resolved = resolve(this.cwd, path.startsWith("~/") ? join(this.home, path.slice(2)) : path);
      const absolute = this.#resolveHomeAlias(resolved);
      this.#remember(basename(absolute) === skillDocument ? dirname(absolute) : absolute);
    }

    scanWorkDir(this.cwd, (path) => this.#remember(path));

    for (const [root, before] of this.#roots) {
      if (!before || this.#found.size >= maxCandidates) continue;

      for (const [path, version] of inventory(root) ?? []) if (before.get(path) !== version) this.#remember(path);
    }

    return [...this.#found.keys()];
  }

  collect(path: string): SkillArtifact | undefined {
    return this.#found.get(path)?.();
  }

  #resolveHomeAlias(path: string): string {
    return inside(this.home, path) ? join(this.#home, relative(this.home, path)) : path;
  }

  #remember(path: string): void {
    if (path.length > 4096 || this.#found.has(path) || this.#found.size >= maxCandidates) return;

    if (!inside(this.cwd, path) && ![...this.#roots.keys()].some((root) => root !== path && inside(root, path))) return;

    try {
      const preview = captureSkillDirectory(path);

      if (preview) this.#found.set(path, preview);
    } catch {
      // Terminal text and filesystem entries can both refer to invalid or disappearing paths.
    }
  }
}
