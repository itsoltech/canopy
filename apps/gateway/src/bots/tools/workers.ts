import { Provider } from "@open-agents/contracts";
import { define, label, object, str } from "./shared.ts";
import { NotFound } from "../../store/store.ts";

export const workerTools = [
  define("list_workers", "Workers: list accessible workers, online status, OS, allowed roots and enabled/available provider instances. Worker registration needs a CLI credential: the user must register the worker using the CLI; bots cannot register workers or obtain that secret.", object({}), "Checking workers", async ({ core }) => (await core.overview()).workers.map((w) => ({ id: w.id, name: w.name, online: w.online, os: w.os, hostname: w.hostname, allowed_roots: w.allowedRoots, provider_instances: w.providerInstances.map((i) => ({ id: i.id, label: i.label, provider: Provider[i.harness], enabled: i.enabled, available: i.available })) })), "read"),
  define("list_directory", "Workers: browse directories using the same remote DirectoryPicker API as the UI, restricted to the worker's allowed roots. Empty path lists roots. No file content, local filesystem or directory creation.", object({ worker_id: str, path: str }, ["worker_id"]), (a) => `Checking directories on ${label(a["worker_name"], "a worker")}`, async ({ core, string, optional }) => {
    if (!(await core.overview()).workers.some((w) => w.id === string("worker_id"))) throw new NotFound("worker not found");
    return { entries: (await core.listDirectory(string("worker_id"), optional("path"))).entries.map((e) => ({ name: e.name, is_directory: e.isDir, is_git_repo: e.isGitRepo })) };
  }, "read"),
];
