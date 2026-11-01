import { fail } from "@sveltejs/kit";
import { createThreadFromForm } from "#lib/features/threads/server/create-thread.ts";
import type { Actions } from "./$types";

export const actions: Actions = {
  /** Side thread under this thread's main thread (same workspace; the gateway checks the placement). */
  createSideThread: async ({ request }) => {
    const form = await request.formData();
    const projectId = String(form.get("projectId") ?? "");
    if (!projectId || !form.get("parentThreadId")) return fail(400, { action: "side", error: "Missing parent thread" });
    return createThreadFromForm(form, projectId, "side");
  },
};
