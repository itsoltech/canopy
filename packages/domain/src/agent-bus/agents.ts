/**
 * What a subagent can run on (docs/agent-bus.md, "Subagenci dowolnego dostawcy"): any provider instance + model +
 * effort the user could pick for a thread in the caller's workspace. Pure: the gateway passes the instances the
 * worker reports (enabled, available, with the pickers' model catalogs) and asks here, for spawn_thread and for
 * list_agents alike.
 */

import { Result } from "effect";
import { HARNESS_NAMES, isHarness, type Harness } from "../harnesses.ts";

export type { Harness } from "../harnesses.ts";

export interface SpawnModel {
  readonly id: string;
  /** The model an alias resolves to (Claude "opus" -> claude-opus-5-5); empty when the same. */
  readonly resolvedModel?: string;
  readonly label: string;
  /** Empty = the model takes no effort (or it is not known). */
  readonly efforts: readonly string[];
  readonly defaultEffort: string;
  readonly serviceTiers?: readonly string[];
  readonly isDefault: boolean;
  /** Not shown in the pickers (still accepted, like a user may type it). */
  readonly hidden: boolean;
}

/** A provider instance on the caller's worker. */
export interface SpawnInstance {
  readonly harness: Harness;
  readonly id: string;
  readonly label: string;
  /** Turned on for the worker and reported available there (harness installed, logged in). */
  readonly available: boolean;
  readonly detail?: string;
  /** The worker's model catalog for the instance; undefined = none reported (not judged). */
  readonly models?: readonly SpawnModel[];
  /** The catalog is complete (an incomplete one is not judged either). */
  readonly complete: boolean;
}

/** What a thread runs on: harness, instance (provider_profile_id, "native" = the device login), model, effort. */
export interface SpawnTarget {
  readonly harness: Harness;
  readonly instance: string;
  /** "" = the instance's default model. */
  readonly model: string;
  /** "" = the model's default effort, or none. */
  readonly effort: string;
  readonly serviceTier?: string;
}

export type SpawnResolution =
  | { readonly ok: true; readonly target: SpawnTarget }
  | { readonly ok: false; readonly reason: string };

/** Provider ID for spawn_thread and start_thread, e.g. "codex/native". */
export const agentKey = (target: Pick<SpawnTarget, "harness" | "instance">): string =>
  `${target.harness}/${target.instance || "native"}`;

/**
 * The target of spawn_thread. Without `provider` (or naming the caller's own instance) the subagent runs where the
 * caller does, with its model and effort unless the call names others (checked against that catalog when given).
 * Another instance must be on the worker and available; its model defaults to the instance's default model and the
 * effort to that model's default. A model must be in the instance's catalog and an effort among the model's (a model
 * without efforts takes none). `instances` undefined = the worker has not reported yet: only the caller's own
 * instance can be used.
 */
export function resolveSpawnTarget(
  args: {
    readonly provider?: string | undefined;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
    readonly service_tier?: string | undefined;
  },
  caller: SpawnTarget,
  instances: readonly SpawnInstance[] | undefined,
): SpawnResolution {
  const fail = (reason: string): SpawnResolution => ({ ok: false, reason });

  if (args.effort !== undefined && !/^[a-z][a-z0-9_-]*$/.test(args.effort))
    return fail(`invalid reasoning effort "${args.effort}"`);

  if (args.service_tier !== undefined && !/^[a-z][a-z0-9_-]{0,39}$/.test(args.service_tier))
    return fail("Choose a speed from list_agents.");
  const own = { harness: caller.harness, instance: caller.instance || "native" };
  let chosen: SpawnInstance | undefined;

  if (args.provider !== undefined) {
    const found = findInstance(args.provider.trim().toLowerCase(), own, instances);

    if (Result.isFailure(found)) return fail(found.failure);
    chosen = found.success;
  }

  const same = !chosen || (chosen.harness === own.harness && chosen.id === own.instance);

  if (same) {
    const instance = instances?.find((i) => i.harness === own.harness && i.id === own.instance);
    const model = args.model ?? caller.model;
    const effort = args.effort ?? caller.effort;
    const info = instance && findModel(instance, model);

    const inheritedTier =
      args.model === undefined || model === caller.model || info?.serviceTiers?.includes(caller.serviceTier ?? "")
        ? caller.serviceTier
        : undefined;

    const serviceTier = args.service_tier ?? inheritedTier;

    if (args.service_tier !== undefined) {
      const problem = serviceTierProblem(info, args.service_tier);

      if (problem) return fail(problem);
    }

    // The caller's own settings are not judged again; what the call changes is.
    if (instance && (args.model !== undefined || args.effort !== undefined)) {
      const problem = modelProblem(instance, model, args.effort ?? "");

      if (problem) return fail(problem);
    }

    return { ok: true, target: { ...own, model, effort, ...(serviceTier && { serviceTier }) } };
  }

  const instance = chosen!;

  if (!instance.available)
    return fail(
      `${agentKey({ harness: instance.harness, instance: instance.id })} is not available on this worker${instance.detail ? `: ${instance.detail}` : ""}`,
    );
  const info = findModel(instance, args.model ?? "");
  const model = args.model ?? info?.id ?? "";
  const problem = modelProblem(instance, model, args.effort ?? "");

  if (problem) return fail(problem);
  const tierProblem = serviceTierProblem(info, args.service_tier);

  if (tierProblem) return fail(tierProblem);
  const effort = info && info.efforts.length === 0 ? "" : (args.effort ?? info?.defaultEffort ?? "");

  return {
    ok: true,
    target: {
      harness: instance.harness,
      instance: instance.id,
      model,
      effort,
      ...(args.service_tier && { serviceTier: args.service_tier }),
    },
  };
}

function serviceTierProblem(model: SpawnModel | undefined, tier: string | undefined): string | undefined {
  if (!tier || tier === "default" || model?.serviceTiers?.includes(tier)) return undefined;

  return "This speed is not available for this model. Choose a speed from list_agents.";
}

/**
 * "codex/native", "codex:native", "codex" (yours when you run on Codex, else its native instance, else the first) or
 * an instance id ("cliproxyapi"; yours first when both harnesses have it).
 */
function findInstance(
  wanted: string,
  own: { harness: Harness; instance: string },
  instances: readonly SpawnInstance[] | undefined,
): Result.Result<SpawnInstance, string> {
  const [first = "", second] = wanted.split(/[/:]/, 2);

  const isOwn =
    second === undefined
      ? first === own.harness || first === own.instance
      : first === own.harness && second === own.instance;

  if (isOwn)
    return Result.succeed(
      instances?.find((i) => i.harness === own.harness && i.id === own.instance) ?? {
        harness: own.harness,
        id: own.instance,
        label: "",
        available: true,
        complete: false,
      },
    );

  if (!instances)
    return Result.fail(
      `the worker has not reported its providers yet: omit provider to start a copy of yourself (${agentKey(own)})`,
    );
  const unknown = `no provider "${wanted}" on this worker; call list_agents for the ones you can start`;

  const found = (instance: SpawnInstance | undefined) =>
    instance === undefined ? Result.fail(unknown) : Result.succeed(instance);

  if (second !== undefined) {
    if (!isHarness(first)) return Result.fail(unknown);

    return found(instances.find((i) => i.harness === first && i.id === second));
  }

  if (isHarness(first)) {
    const ofHarness = instances.filter((i) => i.harness === first);

    return found(
      ofHarness.find((i) => i.id === "native" && i.available) ?? ofHarness.find((i) => i.available) ?? ofHarness[0],
    );
  }

  const byId = instances.filter((i) => i.id === first);

  if (byId.length > 1)
    return Result.fail(
      `"${wanted}" is an instance of several providers: say ${byId.map((i) => agentKey({ harness: i.harness, instance: i.id })).join(" or ")}`,
    );

  return found(byId[0]);
}

function findModel(instance: SpawnInstance, model: string): SpawnModel | undefined {
  const models = instance.models ?? [];

  return model ? models.find((m) => m.id === model || m.resolvedModel === model) : models.find((m) => m.isDefault);
}

/** Lenient where the catalog cannot tell: none reported, an incomplete or empty one, a model without effort data. */
function modelProblem(instance: SpawnInstance, model: string, effort: string): string | undefined {
  if (!instance.models || !instance.complete || instance.models.length === 0) return undefined;
  const key = agentKey({ harness: instance.harness, instance: instance.id });
  const info = findModel(instance, model);

  if (model && !info) return `${key} does not offer the model "${model}"; call list_agents for its models`;

  if (effort && info && info.efforts.length > 0 && !info.efforts.includes(effort)) {
    return `${info.label || info.id} supports the reasoning efforts ${info.efforts.join(", ")}, not "${effort}"`;
  }

  return undefined;
}

/** Compact worker model catalog for spawn_thread and start_thread. */
export function agentCatalog(caller: SpawnTarget, instances: readonly SpawnInstance[] | undefined) {
  const you = agentKey({ harness: caller.harness, instance: caller.instance });

  const agents = (instances ?? [])
    .filter((i) => i.available)
    .map((i) => {
      const models = (i.models ?? []).filter((m) => !m.hidden);

      return {
        provider: agentKey({ harness: i.harness, instance: i.id }),
        name: `${HARNESS_NAMES[i.harness]} · ${i.label || (i.id === "native" ? "device login" : i.id)}`,
        models: models.slice(0, 40).map((m) => ({
          id: m.id,
          ...(m.label && m.label !== m.id && { name: m.label }),
          ...(m.efforts.length > 0 && { efforts: [...m.efforts] }),
          ...(m.defaultEffort && { default_effort: m.defaultEffort }),
          ...(m.serviceTiers?.length && { service_tiers: [...m.serviceTiers] }),
          ...(m.isDefault && { default: true }),
        })),
        ...(!i.models || i.models.length === 0
          ? { note: "no model list reported: omit model to use the default" }
          : !i.complete
            ? { note: "model list may be incomplete" }
            : {}),
      };
    });

  return {
    you: {
      provider: you,
      model: caller.model,
      effort: caller.effort,
      ...(caller.serviceTier && { service_tier: caller.serviceTier }),
    },
    agents,
    note:
      "Choose provider, model and effort from this worker's catalog. Use spawn_thread to delegate to a side thread. " +
      "Its defaults copy your settings, and fork keeps your provider. Use start_thread for an independent task in a configured placement.",
  };
}
