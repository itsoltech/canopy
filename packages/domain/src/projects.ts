import type { ui } from "@canopy/contracts";

/** Transport-independent identity. Paths keep their case: some Git hosts distinguish it. */
export function normalizeGitOrigin(remote: string): string {
  const input = remote.trim();

  if (!input || /^[a-z]:/i.test(input) || /[\s\\]/.test(input) || [...input].some((char) => char.charCodeAt(0) < 32))
    return "";
  const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(input);
  let url: URL;

  try {
    url = new URL(input.includes("://") ? input : scp ? `ssh://${scp[1]}/${scp[2]}` : "");
  } catch {
    return "";
  }

  if (!["ssh:", "https:", "http:", "git:"].includes(url.protocol) || !url.hostname || url.search || url.hash) return "";
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");

  if (!path || path.split("/").some((part) => !part || part === "." || part === "..")) return "";

  // Default ports describe a transport, not a different repository. Keep nonstandard ports distinct.
  const port =
    url.port && !["ssh:22", "https:443", "http:80", "git:9418"].includes(`${url.protocol}${url.port}`)
      ? `:${url.port}`
      : "";

  return `${url.hostname.toLowerCase()}${port}/${path}`;
}

export type ProjectChoice = ui.Project & {
  /** Original records stay intact: workspace.projectId always identifies the thread's home project. */
  projectIds: string[];
  aliases: string[];
};

function projectOrigin(project: ui.Project): string {
  if (!project.workspaces.length || project.workspaces.some((workspace) => !workspace.gitOrigin)) return "";
  const origins = new Set(project.workspaces.map((workspace) => workspace.gitOrigin));

  return origins.size === 1 ? [...origins][0]! : "";
}

/** Presentation only. Never combines ambiguous project records on the same gateway. */
export function projectChoices(projects: readonly ui.Project[]): ProjectChoice[] {
  const identities = new Map<string, ui.Project[]>();

  for (const project of projects) {
    const key = project.globalId ? `global:${project.globalId}` : `project:${project.id}`;
    identities.set(key, [...(identities.get(key) ?? []), project]);
  }

  const buckets = new Map<string, ui.Project[][]>();

  for (const [identity, members] of identities) {
    const origins = new Set(members.map(projectOrigin).filter(Boolean));
    const origin = origins.size === 1 ? [...origins][0] : "";
    const key = members[0]!.kind === "scratch" ? "scratch" : origin || identity;
    buckets.set(key, [...(buckets.get(key) ?? []), members]);
  }

  return [...buckets].flatMap(([key, identities]) => {
    const homes = identities.flatMap((members) => [...new Set(members.map((p) => p.nodeId))]);
    const groups = key !== "scratch" && new Set(homes).size !== homes.length ? identities : [identities.flat()];

    return groups.map((group) => {
      const ordered = [...group].sort(
        (a, b) => Number(Boolean(a.nodeId)) - Number(Boolean(b.nodeId)) || a.id.localeCompare(b.id),
      );

      const first = ordered[0]!;
      const workspaces = new Map<string, ui.Workspace>();

      // A local aggregate can already contain a workspace also present in a retained peer record.
      for (const workspace of ordered.flatMap((project) => project.workspaces))
        if (!workspaces.has(workspace.id)) workspaces.set(workspace.id, workspace);

      return {
        ...first,
        workspaces: [...workspaces.values()],
        projectIds: [...new Set(ordered.map((project) => project.id))],
        aliases: [...new Set(ordered.map((project) => project.name))].filter((name) => name !== first.name),
      };
    });
  });
}

/** Expands persisted sidebar selections as the set of linked computers changes. */
export function expandProjectIds(ids: readonly string[], choices: readonly ProjectChoice[]): string[] {
  return [
    ...new Set(ids.flatMap((id) => choices.find((choice) => choice.projectIds.includes(id))?.projectIds ?? [id])),
  ];
}
