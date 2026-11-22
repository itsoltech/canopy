import type { v2 } from "@canopy/codex-protocol";
import { PermissionMode, type ThreadSpec } from "@canopy/contracts";
import { sandboxBinding } from "@canopy/domain/sandbox-profiles";
import { Effect, Result, Schema } from "effect";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { CODEX_SANDBOX_VERSION } from "../sandbox-versions.ts";
import { CodexThreadError, type CodexThreadContext, type Entry } from "./thread-types.ts";

const workspace = ":workspace";
const profilePrefix = "canopy_sandbox_";
const staticLayer = new Set(["system", "user", "sessionFlags", "packagedDefaults"]);

const optionalBoolean = Schema.optionalKey(Schema.NullOr(Schema.Boolean));
const optionalStrings = Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)));
const domainRules = Schema.Record(Schema.String, Schema.Literals(["allow", "deny"]));

const managedPolicy = Schema.Struct({
  requirements: Schema.NullOr(
    Schema.Struct({
      allowedApprovalPolicies: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Json))),
      allowedSandboxModes: optionalStrings,
      allowedPermissionProfiles: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Boolean))),
      featureRequirements: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Boolean))),
      hooks: Schema.optionalKey(Schema.Json),
      network: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            enabled: optionalBoolean,
            managedAllowedDomainsOnly: optionalBoolean,
            allowLocalBinding: optionalBoolean,
            allowUpstreamProxy: optionalBoolean,
            dangerouslyAllowNonLoopbackProxy: optionalBoolean,
            dangerouslyAllowAllUnixSockets: optionalBoolean,
            allowUnixSockets: optionalStrings,
            unixSockets: Schema.optionalKey(Schema.NullOr(domainRules)),
            domains: Schema.optionalKey(Schema.NullOr(domainRules)),
            allowedDomains: optionalStrings,
            reviewDomains: optionalStrings,
          }),
        ),
      ),
    }),
  ),
});

const effectiveConfig = Schema.Struct({
  config: Schema.Struct({
    features: Schema.optionalKey(Schema.NullOr(Schema.JsonObject)),
    permissions: Schema.optionalKey(Schema.NullOr(Schema.JsonObject)),
    hooks: Schema.optionalKey(Schema.Json),
  }),
  layers: Schema.Array(
    Schema.Struct({
      name: Schema.Struct({ type: Schema.String }),
      version: Schema.String,
      disabledReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

type ManagedPolicy = NonNullable<(typeof managedPolicy.Type)["requirements"]>;

type EffectiveConfig = typeof effectiveConfig.Type;

type SandboxResponse = Pick<v2.ThreadStartResponse, "activePermissionProfile" | "approvalPolicy" | "cwd" | "sandbox">;

export interface SandboxEvidence {
  readonly id: string;
  readonly cwd: string;
  readonly network: boolean;
  readonly authority: string;
}

export interface CodexSandboxProfile extends SandboxEvidence {
  readonly config: NonNullable<v2.ThreadStartParams["config"]>;
}

const problem = (threadId: string, message: string) =>
  new CodexThreadError({ threadId, operation: "sandbox profile", message });

function encloses(parent: string, child: string): boolean {
  const path = relative(parent, child);

  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function profileDirectory(ctx: CodexThreadContext, cwd: string): string {
  const home = ctx.options.launch.env["CODEX_HOME"];
  const directory = ctx.options.sandboxProfileRuntime?.policyDirectory;

  if (!home || !directory || !isAbsolute(home) || home !== directory || /[*?[\]{}\p{Cc}]/u.test(directory))
    throw new Error("The verified Codex policy directory must be the private Codex home.");
  const stat = statSync(directory);

  if (
    realpathSync(directory) !== directory ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    encloses(cwd, directory) ||
    encloses(directory, cwd)
  )
    throw new Error("The verified Codex policy directory must be private and separate from the workspace.");

  return directory;
}

function selectedProfile(ctx: CodexThreadContext, spec: ThreadSpec) {
  const binding = spec.sandboxProfile;
  const canonical = binding?.profile && sandboxBinding(binding.profile);

  if (!canonical?.profile || canonical.digest !== binding?.digest)
    throw new Error("The Codex sandbox profile snapshot could not be verified.");

  if (spec.permissionMode !== PermissionMode.FULL_AUTO)
    throw new Error("A custom Codex sandbox profile requires Sandbox mode.");

  const version = /^[^\s/]+\/([^\s]+) /u.exec(ctx.codex.userAgent)?.[1];

  if (process.platform !== "linux" || !ctx.options.sandboxProfileRuntime || version !== CODEX_SANDBOX_VERSION)
    throw new Error("This Codex runtime has not verified custom command sandbox enforcement.");

  const domains = canonical.profile.allowedDomains;

  if (domains.some((domain) => new URL(`http://${domain}`).hostname !== domain))
    throw new Error("The Codex sandbox profile must contain exact DNS hostnames.");

  const cwd = realpathSync(spec.cwd);
  const directory = profileDirectory(ctx, cwd);
  const id = `${profilePrefix}${canonical.digest}`;

  return { id, cwd, directory, domains };
}

function configProblem({ config, layers }: EffectiveConfig, id: string) {
  if (layers.some((layer) => layer.disabledReason == null && !staticLayer.has(layer.name.type)))
    return "Codex has an active project or managed configuration layer that could override the sandbox profile.";

  if (config.permissions && Object.hasOwn(config.permissions, id))
    return "The Codex sandbox profile name already exists in the effective configuration.";

  if (config.hooks != null || config.features?.["use_legacy_landlock"] === true)
    return "The effective Codex hooks or Linux sandbox backend conflict with the sandbox profile.";
  const proxy = config.features?.["network_proxy"];

  if (proxy != null && proxy !== true && proxy !== false)
    return "Codex already has a custom network proxy configuration that the sandbox profile would replace.";

  return undefined;
}

function managedProblem(policy: ManagedPolicy | null, id: string, domains: readonly string[]) {
  const approval = policy?.allowedApprovalPolicies;
  const modes = policy?.allowedSandboxModes;
  const profiles = policy?.allowedPermissionProfiles;
  const feature = policy?.featureRequirements;

  if (
    (approval && !approval.includes("never")) ||
    (modes && !modes.includes("workspace-write")) ||
    (profiles && !profiles[id])
  )
    return "The effective managed Codex requirements do not permit the named sandbox profile and approval policy.";

  if (policy?.hooks != null || feature?.["hooks"] === true || feature?.["use_legacy_landlock"] === true)
    return "The effective managed Codex hooks or Linux sandbox backend conflict with the sandbox profile.";

  if (feature?.["goals"] === true)
    return "The effective managed Codex requirements enable harness goals for this sandbox profile.";

  const network = policy?.network;

  if (
    network?.allowLocalBinding === true ||
    network?.allowUpstreamProxy === true ||
    network?.dangerouslyAllowNonLoopbackProxy === true ||
    network?.dangerouslyAllowAllUnixSockets === true ||
    network?.allowUnixSockets?.length ||
    Object.values(network?.unixSockets ?? {}).includes("allow") ||
    network?.reviewDomains?.length
  )
    return "The effective managed Codex network requirements permit additional network routes or approvals.";

  if (!domains.length)
    return network?.enabled === true
      ? "The effective managed Codex requirements activate networking for this offline profile."
      : undefined;

  if (
    network?.enabled !== true ||
    network.managedAllowedDomainsOnly !== true ||
    !network.domains ||
    feature?.["network_proxy"] === false
  )
    return "Codex requires an active managed-only network allowlist to enforce exact domains without saved grants.";

  const allows = Object.entries(network.domains).flatMap(([domain, rule]) =>
    rule === "allow" ? [domain.toLowerCase()] : [],
  );

  const matches = (values: readonly string[]) =>
    values.length === domains.length && [...values].sort().every((value, index) => value === domains[index]);

  if (!matches(allows) || !matches((network.allowedDomains ?? []).map((domain) => domain.toLowerCase())))
    return "The effective managed Codex network allowlist must equal this sandbox profile's exact domain list.";

  return undefined;
}

export function codexSandboxProfile(ctx: CodexThreadContext, spec: ThreadSpec) {
  return Effect.gen(function* () {
    if (!spec.sandboxProfile) return undefined;

    const { id, cwd, directory, domains } = yield* Effect.try({
      try: () => selectedProfile(ctx, spec),
      catch: (error) =>
        problem(spec.threadId, error instanceof Error ? error.message : "Could not verify the sandbox profile."),
    });

    const rawConfig = yield* ctx.codex
      .request("config/read", { cwd, includeLayers: true })
      .pipe(Effect.mapError(() => problem(spec.threadId, "Could not read the effective Codex configuration layers.")));

    const config = yield* Schema.decodeUnknownEffect(effectiveConfig)(rawConfig).pipe(
      Effect.mapError(() => problem(spec.threadId, "Codex returned unrecognized effective configuration layers.")),
    );

    const rawPolicy = yield* ctx.codex
      .request("configRequirements/read", null)
      .pipe(Effect.mapError(() => problem(spec.threadId, "Could not read the effective managed Codex requirements.")));

    const { requirements } = yield* Schema.decodeUnknownEffect(managedPolicy)(rawPolicy).pipe(
      Effect.mapError(() => problem(spec.threadId, "Codex returned unrecognized managed requirements.")),
    );

    const conflict = configProblem(config, id) ?? managedProblem(requirements, id, domains);

    if (conflict) return yield* problem(spec.threadId, conflict);
    const network = domains.length > 0;
    // Codex can report an inactive project layer only after opening a thread.
    const activeLayers = config.layers.filter((layer) => layer.disabledReason == null);
    const authority = Bun.CryptoHasher.hash("sha256", JSON.stringify([directory, activeLayers, rawPolicy]), "hex");

    return {
      id,
      cwd,
      network,
      authority,
      config: {
        "features.hooks": false,
        "features.goals": false,
        ...(network && { "features.network_proxy": true }),
        [`permissions.${id}`]: {
          extends: workspace,
          // An exec-policy allow cannot bypass a sandbox with denied reads on the qualified releases.
          filesystem: { [directory]: "deny" },
          network: {
            enabled: network,
            enable_socks5: false,
            enable_socks5_udp: false,
            allow_local_binding: false,
            allow_upstream_proxy: false,
            dangerously_allow_non_loopback_proxy: false,
            dangerously_allow_all_unix_sockets: false,
          },
        },
      },
    } satisfies CodexSandboxProfile;
  });
}

export function assertWarmSandbox(spec: ThreadSpec, entry: Entry, profile: SandboxEvidence | undefined) {
  if (
    entry.sandboxProfileInvalid ||
    entry.sandboxProfile?.id !== profile?.id ||
    entry.sandboxProfile?.cwd !== profile?.cwd ||
    entry.sandboxProfile?.authority !== profile?.authority
  )
    return Effect.fail(
      problem(
        spec.threadId,
        "The loaded Codex session has a different sandbox profile or policy. Unload it before resuming.",
      ),
    );

  return Effect.void;
}

export function verifiedSandbox(profile: SandboxEvidence, response: SandboxResponse): boolean {
  return (
    response.approvalPolicy === "never" &&
    response.activePermissionProfile?.id === profile.id &&
    response.activePermissionProfile.extends === workspace &&
    response.cwd === profile.cwd &&
    response.sandbox?.type === "workspaceWrite" &&
    response.sandbox.networkAccess === profile.network
  );
}

export function verifySandboxResponse(
  ctx: CodexThreadContext,
  spec: ThreadSpec,
  profile: SandboxEvidence | undefined,
  response: v2.ThreadStartResponse | v2.ThreadResumeResponse | v2.ThreadForkResponse,
) {
  return Effect.gen(function* () {
    const id = response?.thread?.id;
    const registered = id ? ctx.byCodex.get(id) : undefined;

    if (!profile && !registered?.sandboxProfile && !response?.activePermissionProfile?.id.startsWith(profilePrefix))
      return;

    if (registered && registered.platformId !== spec.threadId)
      return yield* problem(spec.threadId, "The Codex session already belongs to another platform thread.");

    if (id && profile && verifiedSandbox(profile, response)) {
      const observed = yield* codexSandboxProfile(ctx, spec).pipe(Effect.result);

      if (Result.isSuccess(observed) && observed.success?.authority === profile.authority) return;
    }

    if (registered) registered.sandboxProfileInvalid = true;

    if (id) yield* ctx.codex.request("thread/unsubscribe", { threadId: id }).pipe(Effect.ignore);

    return yield* problem(
      spec.threadId,
      "Codex did not confirm the requested effective sandbox profile and managed policy.",
    );
  });
}
