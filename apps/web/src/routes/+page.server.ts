import { fail } from "@sveltejs/kit";
import { createThreadFromForm } from "#lib/features/threads/server/create-thread.ts";
import type { Actions } from "./$types";

export const actions: Actions = {
  /** New main thread from the home composer; the project comes with the chosen workspace. */
  createThread: async ({ request }) => {
    const form = await request.formData();
    const projectId = String(form.get("projectId") ?? "");
    if (!projectId) return fail(400, { action: "thread", error: "Choose a workspace" });
    if (!String(form.get("message") ?? "").trim()) return fail(400, { action: "thread", error: "Tell the agent what to do" });
    return createThreadFromForm(form, "thread", { projectId });
  },
};
