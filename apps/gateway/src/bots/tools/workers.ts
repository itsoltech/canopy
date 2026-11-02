import { Provider } from "@open-agents/contracts";
import { define, label, object, str } from "./shared.ts";
import { NotFound } from "../../store/store.ts";

export const workerTools = [
  define("list_workers", "Workers: list accessible workers, online status, OS and enabled/available provider instances. Worker registration needs a CLI credential: the user must register the worker using the CLI; bots cannot register workers or obtain that secret.", object({}), "Checking workers", async ({ core }) => (await core.overview()).workers.map((w) => ({ id: w.id, name: w.name, online: w.online, os: w.os, hostname: w.hostname, provider_instances: w.providerInstances.map((i) => ({ id: i.id, label: i.label, provider: Provider[i.harness], enabled: i.enabled, available: i.available })) })), "read"),
  define("list_directory", "Workers: browse any accessible absolute directory using the same remote DirectoryPicker API as the UI. Empty path opens the worker's home; / opens the filesystem root on POSIX. No file content, local filesystem or directory creation.", object({ worker_id: str, path: str }, ["worker_id"]), (a) => `Checking directories on ${label(a["worker_name"], "a worker")}`, async ({ core, string, optional }) => {
    if (!(await core.overview()).workers.some((w) => w.id === string("worker_id"))) throw new NotFound("worker not found");
    const listing = await core.listDirectory(string("worker_id"), optional("path"));
    return { path: listing.path, entries: listing.entries.map((e) => ({ name: e.name, is_directory: e.isDir, is_git_repo: e.isGitRepo })) };
  }, "read"),
];
