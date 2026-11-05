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
  const buckets = new Map<string, ui.Project[]>();

  for (const project of projects) {
    const origin = project.kind === "scratch" ? "scratch" : projectOrigin(project);
    const key = origin || `project:${project.id}`;
    buckets.set(key, [...(buckets.get(key) ?? []), project]);
  }

  return [...buckets].flatMap(([key, members]) => {
    const homes = members.map((project) => project.nodeId);

    const groups =
      key !== "scratch" && new Set(homes).size !== members.length ? members.map((project) => [project]) : [members];

    return groups.map((group) => {
      const ordered = [...group].sort(
        (a, b) => Number(Boolean(a.nodeId)) - Number(Boolean(b.nodeId)) || a.id.localeCompare(b.id),
      );

      const first = ordered[0]!;

      return {
        ...first,
        workspaces: ordered.flatMap((project) => project.workspaces),
        projectIds: ordered.map((project) => project.id),
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
