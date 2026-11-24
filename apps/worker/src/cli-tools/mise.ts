import { processKey, runProcess } from "@canopy/process-governor";
import { z } from "zod";
import type { DiscoveredCli } from "./discovery.ts";
import type { RecipePlan, RecipeTools } from "./recipes.ts";
import type { Env } from "./shell-env.ts";

export const MISE_GROK_NPM_TOOL = "npm:@xai-official/grok";

/** Install directory names are normalized by mise; never upgrade its node runtime for an npm global CLI. */
export function miseTool(cli: Pick<DiscoveredCli, "spec" | "owner">): string | undefined {
  const { spec, owner } = cli;

  if (!spec.npm) return undefined;
  const npmKey = `npm-${spec.npm.replace(/^@/, "").replaceAll("/", "-")}`;

  if (owner === npmKey) return `npm:${spec.npm}`;

  if (owner === spec.name || (spec.name === "claude" && owner === "claude-code")) return owner;

  return undefined;
}

const versions = z.array(
  z.object({
    version: z.string(),
    installed: z.boolean(),
    source: z.object({ type: z.string(), path: z.string().optional() }),
  }),
);

function probeMise(mise: string, args: string[], home: string, env: Env) {
  const command = {
    argv: [mise, ...args],
    cwd: home,
    env: { ...env, NO_COLOR: "1" },
    timeoutMs: 10_000,
    maxBytes: 64 * 1024,
  };

  return runProcess(command, { kind: "probe", key: processKey(command), ttlMs: 60_000 });
}

export async function miseSupportsToolOption(mise: string, home: string, env: Env): Promise<boolean> {
  try {
    const result = await probeMise(mise, ["use", "--help"], home, env);

    return result.code === 0 && result.stdout.includes("--tool-option");
  } catch {
    return false;
  }
}

async function requestedVersions(mise: string, tool: string, scope: string, home: string, env: Env) {
  const result = await probeMise(mise, ["ls", "--json", scope, tool], home, env);

  if (result.code !== 0) return undefined;
  const parsed = versions.safeParse(JSON.parse(result.stdout));

  return parsed.success ? parsed.data : undefined;
}

/** Require one matching global request; never replace project-only or multi-version declarations. */
export async function singleGlobalMiseVersion(
  mise: string,
  tool: string,
  version: string,
  home: string,
  env: Env,
): Promise<boolean> {
  try {
    const [global, current] = await Promise.all([
      requestedVersions(mise, tool, "--global", home, env),
      requestedVersions(mise, tool, "--current", home, env),
    ]);

    const selected = current?.[0];
    const declared = global?.[0];

    return Boolean(
      global?.length === 1 &&
      current?.length === 1 &&
      declared?.installed &&
      selected?.installed &&
      declared.version === selected.version &&
      // The npm launcher can still use an older shared Grok binary if mise skipped its setup script.
      (selected.version === version || (version && tool === MISE_GROK_NPM_TOOL)) &&
      declared.source.path &&
      selected.source.path === declared.source.path &&
      selected.source.type === declared.source.type,
    );
  } catch {
    return false;
  }
}

/** Update the global request as well as installing it, so pinned versions and shims switch together. */
export function miseRecipe(cli: DiscoveredCli, version: string, tools: RecipeTools): RecipePlan {
  const tool = miseTool(cli);
  const manualCommand = `mise upgrade ${tool ?? cli.owner ?? `npm:${cli.spec.npm}`}`;
  const fallback = { managedBy: "mise", manualCommand };

  if (!tool) return { ...fallback, detail: "Canopy couldn't identify this mise tool. Update it on the computer." };
  const path = cli.path.replaceAll("\\", "/");

  // A direct install path normally cannot follow activation. The active npm Grok launcher uses a shared binary.
  if (!path.includes("/shims/") && !cli.miseActiveLatest)
    return {
      ...fallback,
      detail: "Canopy can update mise shims. Use a mise shim, then check for updates.",
    };
  const mise = tools.which("mise");

  if (!mise) return { ...fallback, detail: "mise wasn't found. Install mise on the computer, then check for updates." };

  if (!cli.miseGlobal)
    return {
      ...fallback,
      detail: "Canopy couldn't confirm a single global mise installation. Update it on the computer.",
    };

  // The postinstall writes the shared binary outside the package, so cached build output cannot restore it.
  const grokSetup = tool === MISE_GROK_NPM_TOOL && cli.miseToolOption;

  return {
    recipe: {
      kind: "run",
      argv: [
        mise,
        "use",
        "--global",
        "--yes",
        ...(version === "latest" ? [] : ["--pin"]),
        ...(grokSetup ? ["--force", "--tool-option", `allow_builds=${cli.spec.npm}`] : []),
        `${tool}@${version}`,
      ],
      ...(grokSetup && { env: { AUBE_SIDE_EFFECTS_CACHE: "false" } }),
    },
  };
}
