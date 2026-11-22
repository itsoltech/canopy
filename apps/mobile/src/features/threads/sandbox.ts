import type { SandboxProfileBinding } from "@canopy/contracts";

export function sandboxProfileLabel(binding: SandboxProfileBinding): string {
  const name = binding.profile?.name;

  return name ? `Sandbox - ${name}` : "Sandbox";
}

export const sandboxShellUnavailable =
  "Shell commands are unavailable with a sandbox profile. Remove ! to use plain text.";

export function startsWithShellCommand(text: string): boolean {
  return text.trimStart().startsWith("!");
}
