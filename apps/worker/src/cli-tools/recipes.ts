import { existsSync } from "node:fs";
import { join } from "node:path";
import { CliInstallMethod } from "@canopy/contracts";
import type { DiscoveredCli } from "./discovery.ts";

/**
 * Fixed install/update recipes per provider and install method (docs/provider-cli.md). The UI only picks a provider
 * and a version; nothing else from the gateway reaches an argv, and the version is validated here. No sudo, no
 * shell strings: an argv array, or the CLI's official installer script downloaded from its fixed HTTPS address and
 * run with bash. A CLI managed by Homebrew, a version manager or a container image gets no recipe, only the
 * command to run there.
 */

export type Recipe =
  | { readonly kind: "run"; readonly argv: readonly string[] }
  | { readonly kind: "script"; readonly url: string; readonly args: readonly string[] };

export interface RecipePlan {
  readonly recipe?: Recipe;
  /** Who manages it instead ("Homebrew", "mise", "the image", …). */
  readonly managedBy?: string;
  /** What to run on the device instead, when there is an exact command. */
  readonly manualCommand?: string;
  readonly detail?: string;
}

const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z][0-9A-Za-z.]{0,40})?$/;

/** "latest" or an exact X.Y.Z[-pre]; anything else is refused before a recipe is built. */
export const validTarget = (version: string): boolean => version === "latest" || SEMVER.test(version);

export interface RecipeTools {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  which(command: string): string | null;
}

export function planRecipe(cli: DiscoveredCli, version: string, tools: RecipeTools): RecipePlan {
  if (!validTarget(version)) throw new Error(`invalid version "${version}"`);
  const { spec } = cli;
  const posix = tools.platform !== "win32";
  const pkg = `${spec.npm}@${version}`;
  const npmOf = (prefix?: string) => {
    const own = prefix && posix ? join(prefix, "bin", "npm") : undefined;
    return own && existsSync(own) ? own : tools.which("npm");
  };
  const bun = () => tools.which("bun") ?? (existsSync(join(tools.home, ".bun", "bin", "bun")) ? join(tools.home, ".bun", "bin", "bun") : null);
  switch (cli.method) {
    case CliInstallMethod.DOCKER:
      return { managedBy: "the image", detail: "Pull a newer worker image or extend it with the CLI version you want." };
    case CliInstallMethod.HOMEBREW:
      return { managedBy: "Homebrew", manualCommand: `brew upgrade ${cli.owner ?? (spec.name === "claude" ? "--cask claude-code" : spec.name)}` };
    case CliInstallMethod.MISE:
      return { managedBy: "mise", manualCommand: cli.owner?.startsWith("npm-") || !cli.owner ? `mise upgrade npm:${spec.npm}` : `mise upgrade ${cli.owner}` };
    case CliInstallMethod.ASDF:
      return { managedBy: "asdf", manualCommand: `asdf install ${cli.owner ?? spec.name} latest` };
    case CliInstallMethod.OTHER:
      return { managedBy: "you", detail: `Installed outside a known installer (${cli.resolvedPath || cli.path}). Update it the way you installed it.` };
    case CliInstallMethod.NATIVE:
      if (spec.name === "claude") return { recipe: { kind: "run", argv: [cli.path, "install", version] } };
      if (spec.script && posix) return { recipe: { kind: "script", url: spec.script, args: version === "latest" ? [] : [version] } };
      return { managedBy: "you", detail: "No recipe for this platform yet." };
    case CliInstallMethod.NPM: {
      const npm = npmOf(cli.owner);
      if (!npm || !cli.owner) return { managedBy: "npm", manualCommand: `npm install -g ${pkg}`, detail: "npm was not found next to the package." };
      return { recipe: { kind: "run", argv: [npm, "install", "--global", "--prefix", cli.owner, "--no-fund", "--no-audit", pkg] } };
    }
    case CliInstallMethod.BUN: {
      const runtime = bun();
      if (!runtime) return { managedBy: "Bun", manualCommand: `bun add -g ${pkg}`, detail: "bun was not found." };
      return { recipe: { kind: "run", argv: [runtime, "add", "--global", pkg] } };
    }
    case CliInstallMethod.NOT_INSTALLED: {
      // The official user-level installer, into the home directory.
      if (spec.script && posix) return { recipe: { kind: "script", url: spec.script, args: version === "latest" ? [] : [version] } };
      if (spec.name === "codex") {
        const npm = tools.which("npm");
        if (npm) return { recipe: { kind: "run", argv: [npm, "install", "--global", "--prefix", join(tools.home, ".local"), "--no-fund", "--no-audit", pkg] } };
        const runtime = bun();
        if (runtime) return { recipe: { kind: "run", argv: [runtime, "add", "--global", pkg] } };
        return { manualCommand: `npm install -g ${pkg}`, detail: "Codex installs with npm or Bun; neither was found on this machine." };
      }
      if (spec.name === "claude") return { manualCommand: "irm https://claude.ai/install.ps1 | iex", detail: "Install Claude Code from PowerShell on this machine." };
      return { detail: "No installer for this platform yet." };
    }
    default:
      return { detail: "Unknown install method." };
  }
}
