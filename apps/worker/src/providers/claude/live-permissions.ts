import { PermissionMode } from "@canopy/contracts";
import { Effect, Schema } from "effect";
import { switchSessionMode } from "./mode-switch.ts";
import type { ClaudeThreadContext, Session } from "./thread-types.ts";

export class PermissionUpdateError extends Schema.TaggedError<PermissionUpdateError>()("PermissionUpdateError", {
  code: Schema.Literals(["TURN_NOT_RUNNING", "INVALID_PERMISSION_MODE", "PERMISSION_UPDATE_FAILED"]),
  message: Schema.String,
}) {}

export const validLivePermissionMode = (mode: PermissionMode): boolean =>
  [
    PermissionMode.ASK,
    PermissionMode.ACCEPT_EDITS,
    PermissionMode.READ_ONLY,
    PermissionMode.FULL_AUTO,
    PermissionMode.FULL_ACCESS,
  ].includes(mode);

/** A partially applied SDK control cannot safely be reused, even if its response was lost. */
export function invalidateSessionPermissions(session: Session): void {
  session.autoAllow = "none";
  session.closing = true;
  session.input.close();
  session.abort.abort();
}

export function livePermissions(ctx: ClaudeThreadContext) {
  return Effect.fn("ClaudeThreads.updateTurnPermissions")(function* (
    threadId: string,
    turnId: string,
    mode: PermissionMode,
    canUpdate: () => boolean = () => true,
  ) {
    if (!validLivePermissionMode(mode))
      return yield* new PermissionUpdateError({ code: "INVALID_PERMISSION_MODE", message: "Choose a permission mode" });

    const session = ctx.sessions.get(threadId);
    const turn = session?.turn;

    const check = () => {
      if (
        !session ||
        !turn ||
        !turnId ||
        turn.turnId !== turnId ||
        ctx.sessions.get(threadId) !== session ||
        session.turn !== turn ||
        turn.ended ||
        turn.interrupting ||
        session.closing ||
        session.abort.signal.aborted ||
        ctx.shuttingDown ||
        !canUpdate()
      )
        throw new PermissionUpdateError({
          code: "TURN_NOT_RUNNING",
          message: "the turn is not running on this worker",
        });
    };

    yield* Effect.tryPromise({
      try: async () => {
        check();

        if (!session) return;

        if (session.sandboxProfileDigest)
          throw new Error(
            "A Claude Sandbox profile is fixed for this turn. Change permissions before starting a new turn.",
          );
        await switchSessionMode(session, mode, {
          check,
          invalidate: () => invalidateSessionPermissions(session),
          applied: async () => {
            const event = await Effect.runPromise(
              ctx.journal.append(threadId, {
                turnId,
                body: { case: "turnPermissionsChanged", value: { permissionMode: mode } },
              }),
            );

            ctx.options.publish(event);
          },
        });
      },
      catch: (error) =>
        error instanceof PermissionUpdateError
          ? error
          : new PermissionUpdateError({
              code: "PERMISSION_UPDATE_FAILED",
              message: error instanceof Error ? error.message : String(error),
            }),
    });
  });
}
