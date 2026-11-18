import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { searchDirectories, withNodeOnPath } from "../cli-tools/locations.ts";
import { installEnv } from "../cli-tools/installer.ts";
import { readHead } from "../cli-tools/managers.ts";
import type { AgentToolSpec } from "./specs.ts";

export type ToolEnv = Readonly<Record<string, string | undefined>>;

export type Which = (name: string) => string | null;

export function managedPrefix(dataDir: string, spec: AgentToolSpec): string {
  return join(dataDir, "agent-tools", spec.executable, spec.version);
}

const executableFile = (path: string, platform: NodeJS.Platform): boolean => {
  try {
    const stat = statSync(path);

    return stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
};

export function executablePaths(name: string, env: ToolEnv, platform: NodeJS.Platform, which?: Which): string[] {
  if (which) {
    const path = which(name);

    return path ? [path] : [];
  }

  const home = env["HOME"] || env["USERPROFILE"] || homedir();
  const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];

  return searchDirectories({ platform, home, env }, name).flatMap((dir) =>
    names.flatMap((file) => {
      const path = join(dir, file);

      return executableFile(path, platform) ? [path] : [];
    }),
  );
}

/** npm's .cmd launchers cannot be passed to spawn without a shell. Resolve their package's bin entry instead. */
export function resolveLauncher(path: string, name: string): string {
  if (extname(path).toLowerCase() !== ".cmd") return path;
  const root = join(dirname(path), "node_modules", name);

  const manifest = z.object({
    bin: z.union([z.string().transform((entry) => ({ [name]: entry })), z.record(z.string(), z.string())]),
  });

  try {
    const bin = manifest.parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).bin;
    const entry = bin[name];
    const target = entry ? resolve(root, entry) : "";

    return target.startsWith(`${resolve(root)}${sep}`) && existsSync(target) ? target : "";
  } catch {
    return "";
  }
}

export function toolCandidates(
  spec: AgentToolSpec,
  env: ToolEnv,
  platform: NodeJS.Platform,
  dataDir?: string,
  which?: Which,
): string[] {
  const managed = dataDir
    ? join(
        managedPrefix(dataDir, spec),
        platform === "win32" ? "" : "bin",
        `${spec.executable}${platform === "win32" ? ".cmd" : ""}`,
      )
    : "";

  return [
    ...new Set(
      [
        ...(managed && existsSync(managed) ? [managed] : []),
        ...executablePaths(spec.executable, env, platform, which),
      ].flatMap((path) => {
        const resolved = resolveLauncher(path, spec.executable);

        return resolved ? [resolved] : [];
      }),
    ),
  ];
}

export function toolEnvironment(source: ToolEnv, platform: NodeJS.Platform = process.platform) {
  const env: NodeJS.ProcessEnv = installEnv(source).env;

  // This is the graphical session's cookie-file path; X11 clients need it to reach the user's display.
  if (source["XAUTHORITY"]) env["XAUTHORITY"] = source["XAUTHORITY"];
  const home = env["HOME"] || env["USERPROFILE"] || homedir();
  const path = withNodeOnPath({ env, platform, home });

  return { ...env, ...(path && { PATH: path }) };
}

export function toolArgv(
  path: string,
  args: readonly string[],
  env: ToolEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const extension = extname(path).toLowerCase();

  // Some npm bin entries, including Agent Desktop, are Node scripts with no extension.
  const nodeShebang =
    platform === "win32" &&
    !extension &&
    /^#!\/usr\/bin\/env[ \t]+node\r?$/.test(readHead(path)?.split("\n", 1)[0] ?? "");

  if (!nodeShebang && ![".js", ".mjs", ".cjs"].includes(extension)) return [path, ...args];
  const node = executablePaths("node", env, platform)[0];

  if (!node) throw new Error("Node.js is required to run this automation tool");

  return [node, path, ...args];
}
