import type { v2 } from "@canopy/codex-protocol";
import type { ThreadSpec } from "@canopy/contracts";
import { Effect } from "effect";
import { pickDefaultEffort } from "../default-effort.ts";
import { codexModel, codexProxyModels, proxyModels } from "../models.ts";
import type { TurnSettings } from "../turn-input.ts";
import type { MentionEntryInit } from "../../mentions/catalog.ts";
import { codexAppEntries, codexPluginEntries, codexSkillEntries } from "./catalog.ts";
import { codexTurnPermissions } from "./permissions.ts";

import { CodexThreadError, fail, type CodexThreadContext } from "./thread-types.ts";

export function threadCatalog(ctx: CodexThreadContext) {
  const { options, codex } = ctx;
  // The bundled catalog (the same for every model provider), listed once per process.
  let catalog: v2.Model[] | undefined;

  const loadCatalog = Effect.gen(function* () {
    if (catalog) return catalog;
    const models: v2.Model[] = [];
    let cursor: string | null = null;

    do {
      const page: v2.ModelListResponse = yield* codex.request("model/list", {
        includeHidden: true,
        ...(cursor && { cursor }),
      });

      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);

    catalog = models;

    return models;
  });

  return {
    loadCatalog,
    listModels: Effect.fn("CodexThreads.listModels")(function* (profileId: string) {
      const profile = options.profile(profileId);

      if (!profile)
        return yield* new CodexThreadError({
          threadId: "",
          operation: "model/list",
          message: `provider profile "${profileId || "native"}" is not available`,
        });
      // A fresh list: model/list again, not the process's cached catalog.
      catalog = undefined;
      const configured = options.configuredEffort?.();

      const models = (yield* loadCatalog.pipe(Effect.mapError(fail("", "model/list")))).map((m) =>
        codexModel(m, configured),
      );

      if (profile.kind !== "cliproxyapi") return { models };

      return yield* Effect.tryPromise(() => proxyModels(profile)).pipe(
        Effect.map((served) => ({ models: codexProxyModels(models, served) })),
        Effect.catch((error) =>
          Effect.succeed({
            models,
            detail: `the proxy's models are unknown: ${error instanceof Error ? error.message : String(error)}`,
          }),
        ),
      );
    }),
    listMentionCatalog: Effect.fn("CodexThreads.listMentionCatalog")(function* (cwd: string, refresh: boolean) {
      const skills = codexSkillEntries(
        yield* codex
          .request("skills/list", { cwds: [cwd], forceReload: refresh })
          .pipe(Effect.mapError(fail("", "skills/list"))),
      );

      const notes = [
        ...skills.notes,
        "commands: Codex runs no slash commands from turn input (its /commands belong to the Codex TUI)",
      ];

      const plugins = yield* codex.request("plugin/list", { cwds: [cwd] }).pipe(
        Effect.map(codexPluginEntries),
        Effect.catch((error) => Effect.sync(() => (notes.push(`plugins: ${error.message}`), []))),
      );

      let apps: MentionEntryInit[] = [];

      if (options.connectors) {
        apps = yield* codex.request("app/list", { forceRefetch: refresh }).pipe(
          Effect.map(codexAppEntries),
          Effect.catch((error) => Effect.sync(() => (notes.push(`apps: ${error.message}`), []))),
        );
      } else {
        notes.push("apps: account connectors are off on this worker");
      }

      return { entries: [...skills.entries, ...plugins, ...apps], notes };
    }),
  };
}

export function threadTurnSettings(
  ctx: CodexThreadContext,
  loadCatalog: ReturnType<typeof threadCatalog>["loadCatalog"],
) {
  const { options } = ctx;

  /**
   * Every turn names its model, effort and permission mode: Codex keeps a turn's override for the turns after
   * it, so a turn without an override goes back to the catalog's default model and the default effort the
   * catalog reports for it (the device owner's configured one when the model offers it, else the model's own),
   * and to the thread's permission mode. Approvals already pending in a running turn keep their own policy.
   */
  const turnSettings = (spec: ThreadSpec, settings: TurnSettings | undefined) =>
    Effect.gen(function* () {
      const models = yield* loadCatalog.pipe(Effect.orElseSucceed((): v2.Model[] => []));
      const model = settings?.model || spec.model || models.find((m) => m.isDefault)?.model || "";
      const listed = models.find((m) => m.model === model);

      const effort =
        settings?.effort ||
        (listed &&
          pickDefaultEffort(
            listed.supportedReasoningEfforts.map((e) => e.reasoningEffort),
            options.configuredEffort?.(),
            listed.defaultReasoningEffort,
          )) ||
        "";

      return {
        ...(model && { model }),
        ...(effort && { effort }),
        ...codexTurnPermissions(settings?.permissionMode || spec.permissionMode),
      };
    });

  return turnSettings;
}
