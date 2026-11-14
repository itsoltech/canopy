import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { notifyDrafts, subscribeDrafts } from "../drafts/events.ts";
import type { GatewayCore } from "../core/core.ts";
import { coreState } from "../core/core-context.ts";
import { composerDraftStore } from "../drafts/store.ts";
import { draftClock, listComposerDrafts } from "../drafts/query.ts";
import { Invalid, NotFound } from "../store/errors.ts";
import { SettingsConflict } from "../store/settings.ts";
import { InvalidError, UnavailableError } from "../core/core.ts";
import { unwrap } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";
import { remoteDraftTitle } from "../drafts/target.ts";
import { reconcileDraftDelivery } from "../drafts/reconcile.ts";

/** Never pass SQL causes (which can contain the payload) to the general logging guard. */
export async function draftGuard<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (cause) {
    const error = unwrap(cause);

    if (cause instanceof ConnectError) throw cause;

    if (error instanceof NotFound) throw new ConnectError(error.message, Code.NotFound);

    if (error instanceof Invalid || error instanceof InvalidError)
      throw new ConnectError(error.message, Code.InvalidArgument);

    if (error instanceof UnavailableError) throw new ConnectError(error.message, Code.Unavailable);

    if (error instanceof SettingsConflict) throw new ConnectError(error.message, Code.FailedPrecondition);
    throw new ConnectError("Could not save or load drafts. Check the connection, then retry.", Code.Internal);
  }
}

export function composerDraftHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "saveComposerDraft"
  | "listComposerDrafts"
  | "continueComposerDraft"
  | "deleteComposerDraft"
  | "watchComposerDrafts"
  | "getComposerDraftDelivery"
> {
  const { runtime, userId } = core[coreState].options;

  return {
    getComposerDraftDelivery: (request, context) =>
      draftGuard(() => reconcileDraftDelivery(core, request, context.signal)),
    saveComposerDraft: (request, context) =>
      draftGuard(async () => {
        const title = await remoteDraftTitle(core, request.draft?.target, context.signal);

        const saved = await runtime.runPromise(
          Effect.gen(function* () {
            return yield* composerDraftStore(yield* SqlClient.SqlClient, userId).save(request, title);
          }),
        );

        notifyDrafts(core);

        return saved;
      }),
    listComposerDrafts: (request) =>
      draftGuard(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            return yield* listComposerDrafts(yield* SqlClient.SqlClient, userId, request);
          }),
        ),
      ),
    continueComposerDraft: (request) =>
      draftGuard(async () => {
        const saved = await runtime.runPromise(
          Effect.gen(function* () {
            return yield* composerDraftStore(yield* SqlClient.SqlClient, userId).continue(request);
          }),
        );

        notifyDrafts(core);

        return saved;
      }),
    deleteComposerDraft: (request) =>
      draftGuard(async () => {
        await runtime.runPromise(
          Effect.gen(function* () {
            yield* composerDraftStore(yield* SqlClient.SqlClient, userId).remove(request);
          }),
        );

        notifyDrafts(core);

        return create(EmptySchema);
      }),
    watchComposerDrafts: async function* (request, context) {
      let revision = request.afterRevision;
      const subscription = subscribeDrafts(core);
      const close = () => subscription.close();
      context.signal.addEventListener("abort", close, { once: true });
      subscription.channel.push(true);

      try {
        for await (const _change of subscription.channel) {
          if (context.signal.aborted) return;

          const next = await draftGuard(() =>
            runtime.runPromise(
              Effect.gen(function* () {
                return yield* draftClock(yield* SqlClient.SqlClient, userId);
              }),
            ),
          );

          if (next !== revision) {
            revision = next;
            yield create(ui.ComposerDraftChangeSchema, { revision });
          }
        }
      } finally {
        context.signal.removeEventListener("abort", close);
        close();
      }
    },
  };
}
