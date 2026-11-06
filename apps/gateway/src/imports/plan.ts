import { create } from "@bufbuild/protobuf";
import { ui, type ImportThreadSummary } from "@canopy/contracts";
import type { GatewayCore } from "../core/core.ts";
import { InvalidError } from "../core/core-context.ts";
import { isWithinWorkspace, pathStyle } from "../store/paths.ts";
import { historyReason, IMPORTABLE_CLIS, matches, suggestion, type CandidateContext } from "./candidates.ts";
import type { ImportTargetJson, NewItem } from "./store.ts";

/**
 * What StartImport creates (docs/import.md, "Plan"): the selected threads of a scan, without the ones this owner
 * already imported, each with a target. A directory's target comes from the request or the suggestion: an existing
 * workspace of the owner on this worker (the thread keeps its directory inside it), a new project for the directory,
 * or "No project". Directories that no longer exist always go to "No project" as history.
 */

/** Agent CLIs whose imported threads can continue natively (later stages add the others). */
export const NATIVE_CLIS: ReadonlySet<string> = new Set<string>([]);

export interface Scratch {
  readonly projectId: string;
  readonly workspaceId: string;
}

export function selected(threads: readonly ImportThreadSummary[], selection: ui.ImportSelection | undefined) {
  if (!selection) return [];

  if (selection.allMatching) {
    const excluded = new Set(selection.excluded);

    return threads.filter((t) => matches(t, selection.filter) && !excluded.has(t.sourceKey));
  }

  const included = new Set(selection.included);

  return threads.filter((t) => included.has(t.sourceKey));
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;

/** One target per source directory; projects asked for are created here (the worker checks the directory). */
export async function directoryTargets(
  core: GatewayCore,
  workerId: string,
  directories: ReadonlyMap<string, boolean>,
  mappings: readonly ui.ImportMapping[],
  context: CandidateContext,
  scratch: () => Promise<Scratch>,
): Promise<Map<string, Omit<ImportTargetJson, "mode"> | "skip">> {
  const chosen = new Map(mappings.map((m) => [m.directory, m.target ?? create(ui.ImportTargetSchema)]));
  const targets = new Map<string, Omit<ImportTargetJson, "mode"> | "skip">();
  // Projects created below count for the next directories.
  const workspaces = [...context.workspaces];

  for (const [directory, exists] of directories) {
    const known = { ...context, workspaces };

    const target = exists
      ? (chosen.get(directory) ?? suggestion(directory, exists, known))
      : suggestion(directory, false, known);

    switch (target.kind) {
      case "skip":
        targets.set(directory, "skip");
        break;
      case "workspace": {
        const workspace = workspaces.find((w) => w.id === target.workspaceId);

        if (!workspace) throw new InvalidError(`The project for ${directory} is not on this worker`);
        const style = pathStyle(context.os, workspace.root_path);
        const inside = isWithinWorkspace(directory, workspace.root_path, style, context.os);
        targets.set(directory, {
          projectId: workspace.project_id,
          workspaceId: workspace.id,
          cwd: inside ? directory : workspace.root_path,
        });
        break;
      }

      case "create_project": {
        const project = await core.createProject(basename(directory));

        const workspace = await core.createWorkspace(
          create(ui.CreateWorkspaceRequestSchema, { projectId: project.id, workerId, rootPath: directory }),
        );

        workspaces.push({
          id: workspace.id,
          project_id: project.id,
          project_name: project.name,
          root_path: workspace.rootPath,
        });
        targets.set(directory, { projectId: project.id, workspaceId: workspace.id, cwd: directory });
        break;
      }

      default: {
        const place = await scratch();
        targets.set(directory, { projectId: place.projectId, workspaceId: place.workspaceId, cwd: directory || "/" });
      }
    }
  }

  return targets;
}

/** The items of a run: history when asked, when the source cannot continue, or when its CLI cannot yet. */
export function newItems(
  threads: readonly ImportThreadSummary[],
  targets: ReadonlyMap<string, Omit<ImportTargetJson, "mode"> | "skip">,
  mode: "continue" | "history",
): NewItem[] {
  return threads.flatMap((t) => {
    const target = targets.get(t.cwd);

    if (!target || target === "skip" || !IMPORTABLE_CLIS.has(t.agentCli)) return [];
    const native = mode === "continue" && !historyReason(t) && NATIVE_CLIS.has(t.agentCli) && target.cwd === t.cwd;

    return [
      {
        agentCli: t.agentCli,
        rootId: t.rootId,
        nativeId: t.nativeId,
        sourceKey: t.sourceKey,
        title: t.title || t.preview,
        cwd: t.cwd,
        snapshot: {
          size: String(t.snapshot?.size ?? 0n),
          modifiedMs: String(t.snapshot?.modifiedMs ?? 0n),
          prefixSha256: t.snapshot?.prefixSha256 ?? "",
        },
        target: { ...target, mode: native ? "native" : "history", cliVersion: t.cliVersion },
        bytes: t.bytes,
      },
    ];
  });
}
