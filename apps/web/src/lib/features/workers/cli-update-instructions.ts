import { CliInstallMethod, Provider, type ui } from "@canopy/contracts";

const packages = new Map([
  [Provider.CLAUDE, "@anthropic-ai/claude-code"],
  [Provider.CODEX, "@openai/codex"],
  [Provider.GROK, "@xai-official/grok"],
]);

export function cliExternalInstructions(item: ui.WorkerCliTool): string {
  const tool = item.tool;

  if (!tool) return "";

  if (tool.manualCommand) return `Run ${tool.manualCommand} on this computer.`;

  const pkg = packages.get(tool.provider);

  if (!pkg) return tool.detail || "Update this agent CLI with its installer.";

  const commands: Partial<Record<CliInstallMethod, string>> = {
    [CliInstallMethod.NPM]: `npm install --global ${pkg}@latest`,
    [CliInstallMethod.BUN]: `bun add --global ${pkg}@latest`,
    [CliInstallMethod.VOLTA]: `volta install ${pkg}@latest`,
    [CliInstallMethod.PNPM]: `pnpm add --global ${pkg}@latest`,
    [CliInstallMethod.YARN]: `yarn global add ${pkg}@latest`,
  };

  const command = commands[tool.method];

  return command ? `Run ${command} on this computer.` : tool.detail || "Update this agent CLI with its installer.";
}
