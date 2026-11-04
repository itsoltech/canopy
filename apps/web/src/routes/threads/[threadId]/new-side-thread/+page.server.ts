import { fail } from "@sveltejs/kit";
import { attempt, failed } from "#lib/server/gateway.ts";
import { createThreadFromForm } from "#lib/features/threads/server/create-thread.ts";
import type { Actions } from "./$types";

export const actions: Actions = {
  /** Side thread under the given main thread; its project, workspace and provider come from the parent. */
  createSideThread: async ({ request, params }) => {
    const form = await request.formData();
    const parentThreadId = params.threadId;

    if (!parentThreadId) return fail(400, { action: "side", error: "Missing parent thread" });
    const result = await attempt("side", (api) => api.getThread({ threadId: parentThreadId }));

    if (failed(result)) return result;

    if (!result.thread) return fail(404, { action: "side", error: "The parent thread no longer exists" });

    return createThreadFromForm(form, "side", { parent: result.thread });
  },
};
