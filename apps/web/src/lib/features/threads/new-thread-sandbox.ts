import { equals } from "@bufbuild/protobuf";
import { SandboxProfileSchema, type SandboxProfile } from "@canopy/contracts";
import { defaultSandboxProfile, sandboxProfileOption, sandboxProfileProblem } from "./sandbox-profiles.ts";

const savedChoice = "saved";

export function newThreadSandboxPicker(
  saved: SandboxProfile | undefined,
  catalog: readonly SandboxProfile[],
  loaded: boolean,
  target: Parameters<typeof sandboxProfileProblem>[0],
) {
  const options = [
    defaultSandboxProfile,
    ...catalog.map((profile) => sandboxProfileOption(profile, sandboxProfileProblem(target, profile))),
  ];

  if (!saved) return { options, value: "", refusal: undefined };
  const current = catalog.find((profile) => profile.id === saved.id);

  const outdated = !loaded
    ? "Checking the saved sandbox profile…"
    : !current
      ? "This sandbox profile was removed from Settings. Choose another profile."
      : !equals(SandboxProfileSchema, saved, current)
        ? "This sandbox profile changed in Settings. Select it again to use the updated policy."
        : undefined;

  if (outdated)
    return {
      options: [...options, { ...sandboxProfileOption(saved, outdated), value: savedChoice }],
      value: savedChoice,
      refusal: outdated,
    };
  const problem = sandboxProfileProblem(target, saved);

  return {
    options,
    value: saved.id,
    refusal: problem ? `${problem} Choose another profile or agent.` : undefined,
  };
}
