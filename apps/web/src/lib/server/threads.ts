import { create } from "@bufbuild/protobuf";
import { ui } from "@open-agents/contracts";
import { call } from "./gateway.ts";

/**
 * Threads of every project, for the thread inbox in the sidebar. The contract lists threads per
 * project only, so the BFF fans out ListThreads (one call per project, in parallel).
 */
export async function listAllThreads(projects: readonly ui.Project[]): Promise<ui.ListThreadsResponse> {
  const lists = await Promise.all(projects.map((p) => call((api) => api.listThreads({ projectId: p.id }))));
  return create(ui.ListThreadsResponseSchema, { threads: lists.flatMap((l) => l.threads) });
}
