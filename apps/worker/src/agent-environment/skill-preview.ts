import { create } from "@bufbuild/protobuf";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { SkillFileSchema, type EnvironmentSkillStatus, type SkillFile } from "@canopy/contracts";
import {
  checkSkillPath,
  SKILL_FILE_BYTES,
  SKILL_FILE_COUNT,
  SKILL_TOTAL_BYTES,
  validateSkillFiles,
} from "@canopy/domain/skill-artifact";
import { inspectSkillCopy, SKILL_INVENTORY_ENTRY_LIMIT } from "./skill-archive.ts";
import { copyChanged, withSkillDirectory, type SkillDirectory } from "./skill-directory.ts";

const linkRefused = () => new Error("A linked skill must point to a folder inside a known device skill directory.");
const inventoryBudget = () => ({ remaining: SKILL_INVENTORY_ENTRY_LIMIT });

function linkedPath(root: SkillDirectory, name: string, roots: ReadonlyMap<string, string>): string {
  const link = root.readLink(name);
  const parts = link.split(process.platform === "win32" ? /[\\/]/ : "/").filter((part) => part && part !== ".");
  const firstName = parts.findIndex((part) => part !== "..");

  // Resolving a trailing '..' lexically could silently change what the link means if a previous component is a link.
  if (
    link.includes("\0") ||
    firstName < 0 ||
    (isAbsolute(link) && firstName !== 0) ||
    parts.slice(firstName).includes("..")
  )
    throw linkRefused();
  const target = resolve(root.path, link);

  if (process.platform === "win32" && target.slice(parse(target).root.length).includes(":")) throw linkRefused();

  for (const known of roots.keys()) {
    const child = relative(known, target);

    if (child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)) return target;
  }

  throw linkRefused();
}

interface LocalSource {
  readonly parent: SkillDirectory;
  readonly name: string;
  readonly token: string;
}

function withLocalSkillLink<T>(
  root: SkillDirectory,
  name: string,
  targetId: string,
  linkToken: string,
  roots: ReadonlyMap<string, string>,
  use: (source: LocalSource) => T,
): T {
  const path = linkedPath(root, name, roots);
  const leaf = basename(path);

  const result = withSkillDirectory(dirname(path), (parent) => {
    if (parent.entry(leaf)?.kind !== "directory") throw linkRefused();
    const source = inspectSkillCopy(parent, leaf, targetId, inventoryBudget());

    if (source.kind !== "directory" || inspectSkillCopy(root, name, targetId, { remaining: 1 }).token !== linkToken)
      throw copyChanged();

    return use({ parent, name: leaf, token: source.token });
  });

  if (result === undefined) throw linkRefused();

  return result;
}

function readLocalCopy({ parent, name, token }: LocalSource, targetId: string): SkillFile[] {
  const files: SkillFile[] = [];
  let total = 0;

  const scanned = inspectSkillCopy(parent, name, targetId, inventoryBudget(), (directory, leaf, entry, path) => {
    checkSkillPath(path);

    if (entry.kind === "directory") return;

    if (entry.kind === "link") throw new Error("Symlinks inside a skill are not allowed.");

    if (entry.kind !== "file") throw new Error("A skill can only contain regular files and folders.");

    if (files.length >= SKILL_FILE_COUNT) throw new Error("A skill can contain up to 1,000 files.");

    const file = directory.readFile(leaf, entry, Math.min(SKILL_FILE_BYTES, SKILL_TOTAL_BYTES - total));
    total += file.content.length;
    files.push(create(SkillFileSchema, { path, ...file }));
  });

  if (scanned.kind !== "directory" || scanned.token !== token) throw copyChanged();

  return files;
}

export function previewLocalSkillCopy(status: EnvironmentSkillStatus, roots: ReadonlyMap<string, string>) {
  const { path, targetId, archiveToken, localName } = status;
  const origin = dirname(path);

  if (!roots.has(origin)) throw copyChanged();

  const withCurrentSource = <T>(use: (source: LocalSource) => T) =>
    withSkillDirectory(origin, (root) => {
      const current = inspectSkillCopy(root, localName, targetId, inventoryBudget());

      if (current.token !== archiveToken) throw copyChanged();

      return current.kind === "link"
        ? withLocalSkillLink(root, localName, targetId, current.token, roots, use)
        : use({ parent: root, name: localName, token: current.token });
    });

  const snapshot = withCurrentSource((source) => ({ files: readLocalCopy(source, targetId), token: source.token }));

  // Reopen both paths from their configured origins after collecting the snapshot.
  if (!snapshot || withCurrentSource((source) => source.token) !== snapshot.token) throw copyChanged();

  return validateSkillFiles(snapshot.files);
}
