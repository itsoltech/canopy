import { GitHubAccounts } from "../github/service.ts";
import type { GatewayCore, GatewayCoreOptions } from "./core.ts";
import { coreArchiveThread } from "./core-threads.ts";

export const createCoreGitHub = (core: GatewayCore, options: GatewayCoreOptions) =>
  new GitHubAccounts(
    options.runtime,
    options.userId,
    options.github,
    (ids) => core.threadsChanged(ids),
    (id) => coreArchiveThread(core, id, true, "merge"),
    () => core.checkWatches.beforeMergeArchive(),
  );
