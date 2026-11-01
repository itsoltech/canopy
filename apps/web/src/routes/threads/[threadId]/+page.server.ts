import { fail, isHttpError } from "@sveltejs/kit";
import { ui } from "@open-agents/contracts";
import { attempt, call, failed } from "#lib/server/gateway.ts";
import { createThreadFromForm } from "#lib/features/threads/server/create-thread.ts";
import { tailSnapshot } from "#lib/features/threads/server/snapshot.ts";
import { encode } from "#lib/shared/wire.ts";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The thread itself (GetThread), so the title, breadcrumb and composer render before the live stream
 * connects; an unknown thread is a 404. With the gateway down the page renders and the stream retries.
 * A full page load also renders the end of the timeline (`tail`); client navigation skips it, the live
 * stream's snapshot is as quick there.
 */
export const load: PageServerLoad = async ({ params, isDataRequest }) => {
  const pendingTail = isDataRequest ? Promise.resolve(undefined) : tailSnapshot(params.threadId);
  try {
    const response = await call((api) => api.getThread({ threadId: params.threadId }));
    const tail = await pendingTail;
    return { thread: response.thread ? encode(ui.ThreadSchema, response.thread) : null, tail: tail ? encode(ui.ThreadSnapshotSchema, tail) : null };
  } catch (cause) {
    if (isHttpError(cause) && cause.status >= 500) return { thread: null, tail: null };
    throw cause;
  }
};

export const actions: Actions = {
  /** Side thread under the given main thread; its project, workspace and provider come from the parent. */
  createSideThread: async ({ request }) => {
    const form = await request.formData();
    const parentThreadId = String(form.get("parentThreadId") ?? "");
    if (!parentThreadId) return fail(400, { action: "side", error: "Missing parent thread" });
    const result = await attempt("side", (api) => api.getThread({ threadId: parentThreadId }));
    if (failed(result)) return result;
    if (!result.thread) return fail(404, { action: "side", error: "The parent thread no longer exists" });
    return createThreadFromForm(form, "side", { parent: result.thread });
  },
};
