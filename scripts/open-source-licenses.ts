import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";
import type { BuildOutput } from "bun";
import { objectOf, parseObject, str } from "../packages/domain/src/json.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
export const licenseAsset = "open-source-licenses.json";

export interface PackageNotice {
  name: string;
  version: string;
  license: string;
  files: { name: string; text: string }[];
}

interface Manifest {
  name: string;
  version: string;
  license: string;
  dependencies: string[];
  optionalDependencies: string[];
  peerDependencies: string[];
}

function manifest(directory: string): Manifest {
  const data = parseObject(readFileSync(join(directory, "package.json"), "utf8"));

  return {
    name: str(data["name"]),
    version: str(data["version"]),
    license: str(data["license"]) || str(objectOf(data["license"])["type"]),
    dependencies: Object.keys(objectOf(data["dependencies"])),
    optionalDependencies: Object.keys(objectOf(data["optionalDependencies"])),
    peerDependencies: Object.keys(objectOf(data["peerDependencies"])),
  };
}

function resolvedPackage(from: string, name: string): string | undefined {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);

    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);

    if (directory === dirname(directory)) return undefined;
  }
}

const noticeName = /(?:^|\.)(?:licen[cs]es?|copying|copyright|(?:third[-_ ]party[-_ ])?notices?|ofl)(?:$|[._-])/i;
const outputDirectories = new Set(["dist", "build", "lib"]);

function noticeFiles(directory: string, bucket = "", inNotices = false): string[] {
  return readdirSync(join(directory, bucket), { withFileTypes: true }).flatMap((entry) => {
    const path = join(bucket, entry.name);
    const namedNotice = noticeName.test(entry.name);

    if (entry.isDirectory() && namedNotice) return noticeFiles(directory, path, true);

    if (entry.isDirectory() && !bucket && outputDirectories.has(entry.name)) return noticeFiles(directory, path);

    if (entry.isFile() && (inNotices || namedNotice)) return [path];

    return [];
  });
}

export function fileNotice(directory: string, files: string[]): PackageNotice["files"] {
  return files.sort().map((file) => ({
    name: file.replaceAll("\\", "/"),
    text: readFileSync(join(directory, file), "utf8"),
  }));
}

export function packageNotice(
  directory: string,
  { name, version, license } = manifest(directory),
): PackageNotice | undefined {
  if (!name || !version || name.startsWith("@canopy/")) return undefined;

  const files = fileNotice(directory, noticeFiles(directory));
  const supplemental = join(root, "licenses", name, version);

  if (existsSync(supplemental)) files.push(...fileNotice(supplemental, noticeFiles(supplemental)));

  if (name.startsWith("@img/sharp-libvips-") || name === "@img/sharp-win32-x64")
    files.push(...sharpNativeNotices(directory));

  return { name, version, license: license || (files.length ? "See accompanying notices" : "Unknown license"), files };
}

function sharpNativeNotices(directory: string): PackageNotice["files"] {
  // Native builds ship a list of their bundled libraries and exact versions.
  const files = ["README.md", "versions.json", "lib/versions.json"].filter((file) => existsSync(join(directory, file)));
  const notices = fileNotice(directory, files);
  const versions = notices.find(({ name }) => name.endsWith("versions.json"));

  if (!versions) return notices;
  const vips = str(parseObject(versions.text)["vips"]);

  if (vips && /^\d+\.\d+\.\d+$/.test(vips)) {
    const upstream = join(root, "licenses", "libvips", vips);

    if (existsSync(upstream))
      notices.push(
        ...fileNotice(upstream, noticeFiles(upstream)).map((file) => ({ ...file, name: "libvips/" + file.name })),
      );
  }

  return notices;
}

export function installedNotice(workspace: string, name: string): PackageNotice {
  const directory = resolvedPackage(resolve(root, workspace), name);
  const notice = directory && packageNotice(directory);

  if (!notice) throw new Error(`Missing package for third-party notices: ${name}`);

  return notice;
}

export function readNotices(json: string): PackageNotice[] {
  // The caller reads JSON emitted by a Canopy build in this invocation.
  return JSON.parse(json);
}

export function mergeNotices(...groups: PackageNotice[][]): PackageNotice[] {
  const unique = new Map<string, PackageNotice>();

  for (const notice of groups.flat()) {
    const key = JSON.stringify([notice.name, notice.version]);
    const existing = unique.get(key);

    if (existing) {
      for (const file of notice.files) {
        if (!existing.files.some((item) => item.name === file.name && item.text === file.text))
          existing.files.push(file);
      }
    } else unique.set(key, { ...notice, files: [...notice.files] });
  }

  return [...unique.values()].sort(
    (a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"),
  );
}

/** Find the package root of a bundled file, including isolated or nested npm installs. */
function modulePackage(id: string): string | undefined {
  const clean = id.replace(/^\0/, "").split("?")[0]?.replaceAll("\\", "/") ?? "";
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^@/][^/]*)(?=\/)/g;
  const last = [...clean.matchAll(match)].at(-1);

  if (!last || last.index === undefined) return undefined;
  const candidate = clean.slice(0, last.index + last[0].length);
  const directory = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);

  return existsSync(join(directory, "package.json")) ? realpathSync(directory) : undefined;
}

export function bundledNotices(ids: Iterable<string>): PackageNotice[] {
  const directories = new Set<string>();

  for (const id of ids) {
    const directory = modulePackage(id);

    if (directory) directories.add(directory);
  }

  return mergeNotices([...directories].flatMap((directory) => packageNotice(directory) ?? []));
}

export function bunNotices(result: BuildOutput): PackageNotice[] {
  if (!result.metafile) throw new Error("Missing Bun bundle metadata for third-party notices");

  return bundledNotices(
    Object.values(result.metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs).flatMap(([file, input]) => (input.bytesInOutput > 0 ? [file] : [])),
    ),
  );
}

/** Mobile and development use installed dependency graphs. Build tools stay outside the graph unless named explicitly. */
export function collectNotices(options: {
  workspaces: string[];
  extras?: PackageNotice[];
  include?: string[];
  dependencies?: { workspace: string; names: string[] };
  exclude?: ReadonlySet<string>;
}): PackageNotice[] {
  const visited = new Set<string>();
  const notices: PackageNotice[] = [];

  function visit(directory: string, include: string[] = []): void {
    if (visited.has(directory)) return;
    visited.add(directory);

    const pkg = manifest(directory);
    const notice = packageNotice(directory, pkg);

    if (notice) notices.push(notice);

    const required = new Set([...pkg.dependencies, ...include]);

    const names = new Set([...required, ...pkg.optionalDependencies, ...pkg.peerDependencies]);

    for (const name of names) {
      if (options.exclude?.has(name)) continue;
      const installed = resolvedPackage(directory, name);

      if (installed) visit(installed);
      else if (required.has(name) && !pkg.optionalDependencies.includes(name))
        throw new Error(`Missing dependency ${name} of ${pkg.name} while collecting third-party notices`);
    }
  }

  for (const workspace of options.workspaces) visit(resolve(root, workspace), options.include);

  if (options.dependencies) {
    const { workspace, names } = options.dependencies;

    for (const name of names) {
      const directory = resolvedPackage(resolve(root, workspace), name);

      if (directory) visit(directory);
    }
  }

  return mergeNotices(notices, options.extras ?? []);
}

export function assetNotices(target: "web" | "mobile"): PackageNotice[] {
  const ui: PackageNotice = {
    name: "Tabler Icons, Griddy Icons and Simple Icons",
    version: "",
    license: "MIT AND CC0-1.0",
    files: fileNotice(join(root, "packages/ui"), ["THIRD_PARTY_NOTICES.md"]),
  };

  if (target === "mobile") return [ui];

  return [
    ui,
    {
      name: "LobeHub Icons",
      version: "",
      license: "MIT",
      files: fileNotice(join(root, "docs"), ["third-party-notices.md"]),
    },
  ];
}

// Expo and React Native declare their development and build CLIs as production dependencies.
const mobileBuildTools = new Set([
  "@expo/cli",
  "@expo/config",
  "@expo/config-plugins",
  "@expo/fingerprint",
  "@expo/local-build-cache-provider",
  "@expo/metro",
  "@expo/metro-config",
  "@react-native/community-cli-plugin",
  "@react-native/gradle-plugin",
  "babel-preset-expo",
  "expo-build-properties",
  "expo-modules-autolinking",
  "expo-modules-cli",
  "flow-parser",
  "hermes-compiler",
  "metro-source-map",
]);

export function releaseNotices(target: "web" | "mobile"): PackageNotice[] {
  if (target === "mobile")
    return collectNotices({ workspaces: ["apps/mobile"], extras: assetNotices("mobile"), exclude: mobileBuildTools });

  return collectNotices({
    workspaces: ["apps/web"],
    include: ["svelte", "@sveltejs/kit", "tailwindcss"],
    extras: assetNotices("web"),
  });
}

export function bunRuntimeNotice(): PackageNotice {
  return {
    name: "Bun and its bundled libraries",
    version: process.versions["bun"] ?? "",
    license: "Multiple licenses",
    files: fileNotice(join(root, "apps/desktop/licenses"), ["Bun-LICENSE.md"]),
  };
}

export function noticesText(notices: PackageNotice[]): string {
  return (
    "Canopy third-party notices\n\n" +
    notices
      .map(({ name, version, license, files }) =>
        [
          `${name}${version ? ` ${version}` : ""}`,
          license,
          ...files.map((file) => `\n${file.name}\n\n${file.text.trimEnd()}`),
        ].join("\n"),
      )
      .join("\n\n" + "=".repeat(72) + "\n\n") +
    "\n"
  );
}

if (import.meta.main) {
  const [target, path] = process.argv.slice(2);

  if ((target !== "web" && target !== "mobile") || !path)
    throw new Error("Usage: bun scripts/open-source-licenses.ts <web|mobile> <output.json>");

  const json = JSON.stringify(releaseNotices(target));
  mkdirSync(dirname(path), { recursive: true });

  // Replacing the file atomically lets Metro workers read it while another build regenerates it.
  if (!existsSync(path) || readFileSync(path, "utf8") !== json) {
    const staged = mkdtempSync(join(dirname(path), ".licenses-"));
    const file = join(staged, "notices.json");

    try {
      writeFileSync(file, json);
      renameSync(file, path);
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  }
}
