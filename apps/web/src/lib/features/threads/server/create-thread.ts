import { redirect } from "@sveltejs/kit";
import type { ui } from "@canopy/contracts";
import { threadCreationMayCheckout, WORKTREE_CLIENT_TIMEOUT_MS } from "@canopy/domain/worktree-timing";
import { attempt, failed } from "#lib/server/gateway.ts";
import { parseThreadForm } from "./thread-form.ts";

export { parseThreadForm } from "./thread-form.ts";

/** Keeps ordinary form actions and browsers without JavaScript on the unary RPC. */
export async function createThreadFromForm(
  form: FormData,
  action: string,
  target: { projectId: string } | { parent: ui.Thread },
) {
  const request = parseThreadForm(form, action, target);

  if (failed(request)) return request;
  const timeoutMs = threadCreationMayCheckout(request) ? WORKTREE_CLIENT_TIMEOUT_MS : 100_000;
  const result = await attempt(action, (api) => api.createThread(request, { timeoutMs }));

  if (failed(result)) return result;
  redirect(303, `/threads/${result.thread?.id}`);
}
