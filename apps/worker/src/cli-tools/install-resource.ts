import { CliInstallMethod } from "@canopy/contracts";
import type { DiscoveredCli } from "./discovery.ts";
import type { Recipe } from "./recipes.ts";

/** Derived from the actual recipe, never a gateway-supplied path or command. */
export function installResource(cli: DiscoveredCli, recipe: Recipe): string {
  if (recipe.kind === "script") return `tool:${cli.spec.name}`;
  const prefix = recipe.argv.indexOf("--prefix");

  if (prefix !== -1) return `prefix:${recipe.argv[prefix + 1]}`;

  if (cli.method === CliInstallMethod.NOT_INSTALLED && recipe.argv[1] === "add") return "bun:global";

  switch (cli.method) {
    case CliInstallMethod.BUN:
      return "bun:global";
    case CliInstallMethod.PNPM:
      return "pnpm:global";
    case CliInstallMethod.VOLTA:
      // Volta updates its shared tools/user inventory and shims.
      return "volta:inventory";
    default:
      return `tool:${cli.spec.name}`;
  }
}
