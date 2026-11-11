import { github } from "@canopy/contracts";
import { GitHubCiController } from "@canopy/domain/github-ci";
import { mutations, page } from "./api.ts";
import { mutationRefused, mutationDetail } from "./mutation-errors.ts";

const controllers = new Map<string, GitHubCiController>();

export function ciController(snapshot: github.PullRequestSnapshot, runId: string) {
  const key = `${snapshot.accountId}:${snapshot.accessRevision}:${snapshot.summary?.ref?.id}:${runId}`;
  let controller = controllers.get(key);

  if (!controller) {
    controller = new GitHubCiController(
      { ...mutations, listPullRequestCheckJobs: (r) => page("jobs", github.PullRequestJobsPageSchema, r) },
      snapshot,
      runId,
      () => crypto.randomUUID(),
      mutationRefused,
      mutationDetail,
    );
    controllers.set(key, controller);

    if (controllers.size > 100) controllers.delete(controllers.keys().next().value ?? "");
  }

  controller.snapshot = snapshot;

  return controller;
}
