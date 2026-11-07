import type { ui } from "@canopy/contracts";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import { settingsSections } from "#lib/features/settings/sections.ts";
import type { SettingsState } from "#lib/features/settings/settings-state.svelte.ts";
import { SIDEBAR_HOTKEY, type SidebarLayout } from "#lib/features/navigation/sidebar-layout.svelte.ts";
import { defaultProject } from "#lib/features/projects/placement.ts";
import { activityOf, byActivity } from "#lib/features/threads/activity.ts";
import { providerKeyOf } from "#lib/features/threads/providers.ts";
import { isSide } from "#lib/features/threads/thread-tree.ts";
import { basename } from "#lib/shared/format.ts";
import type { Command, CommandSource } from "./registry.ts";
import { threadActions } from "#lib/features/threads/thread-actions.ts";
import type { ThreadActions } from "#lib/features/threads/thread-actions.svelte.ts";
import { awayReason } from "#lib/features/computers/computers.ts";
import { appearanceCommands } from "./appearance-commands.ts";
import type { GatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
import type { AddProjectState } from "#lib/features/projects/add/add-project.svelte.ts";

/** New thread in the current project (Mod+N and Mod+Shift+N belong to the browser: new window, private window). */
export const NEW_THREAD_HOTKEY = "Mod+Shift+O";

export interface AppCommandContext {
  readonly capabilities: GatewayCapabilities;
  readonly overview: OverviewState;
  readonly settings: SettingsState;
  readonly sidebar: SidebarLayout;
  readonly threadActions: ThreadActions;
  readonly addProject: AddProjectState;
  /** Opens the navigation drawer (narrow screens, where the sidebar is not shown). */
  readonly openMenu: () => void;
  /** The project of the page (a thread's, the new-thread page's pick), if any. */
  readonly currentProjectId: () => string | undefined;
  readonly currentThreadId: () => string | undefined;
}

const newThreadHref = (project: ui.Project) => `/?project=${encodeURIComponent(project.id)}`;

/** Palette titles of the settings sections ("Threads" alone would read as the thread list). */
const sectionTitles = new Map<string, string>([["/settings/threads", "Thread defaults"]]);

const threadCommand = (overview: OverviewState, thread: ui.Thread, suggested: boolean): Command => {
  const project = overview.project(thread.projectId);
  const worker = overview.worker(thread.workerId);

  return {
    id: `thread:${thread.id}`,
    title: thread.title || "New thread",
    muted: Boolean(thread.nodeId && awayReason(overview.computer(thread.nodeId))),
    detail: thread.nodeId && awayReason(overview.computer(thread.nodeId)) ? "Read-only" : undefined,
    group: "threads",
    href: `/threads/${thread.id}`,
    keywords: [project?.name, worker?.name, basename(thread.cwd)].filter(Boolean).join(" "),
    suggested,
    thread: {
      projectName: project?.name ?? "Unknown project",
      projectKind: project?.kind,
      workerName: worker?.name ?? "Unknown worker",
      provider: providerKeyOf(thread.provider),
      activityAt: activityOf(thread),
    },
  };
};

/** The fixed actions: new threads, the sidebar, appearance, settings and adding a project. */
function actionCommands(context: AppCommandContext, current: ui.Project | undefined): Command[] {
  const { overview, settings, sidebar } = context;

  return [
    {
      id: "new-thread",
      title: current ? `New thread in ${current.name}` : "New thread",
      group: "actions",
      icon: "pencil-square",
      keywords: "new thread chat start compose",
      hotkey: NEW_THREAD_HOTKEY,
      href: current ? newThreadHref(current) : "/",
      rank: -10,
    },
    {
      id: "new-thread-in",
      title: "New thread in…",
      group: "actions",
      icon: "folder-open",
      keywords: "new thread project",
      placeholder: "Search projects…",
      rank: -9,
      when: () => overview.projectChoices.length > 1,
      children: () =>
        overview.projectChoices.map((project) => ({
          id: project.id,
          title: project.name,
          disabled: Boolean(overview.projectAway(project)),
          detail: overview.projectAway(project),
          group: "actions",
          projectName: project.name,
          projectKind: project.kind,
          keywords: project.aliases.join(" "),
          href: newThreadHref(project),
          checked: project.id === current?.id,
        })),
    },
    {
      id: "toggle-sidebar",
      title: "Toggle sidebar",
      group: "actions",
      icon: "sidebar",
      keywords: "navigation collapse expand hide show",
      hotkey: SIDEBAR_HOTKEY,
      rank: 10,
      // The desktop sidebar from lg; below it the navigation is a drawer.
      run: () => (matchMedia("(min-width: 64rem)").matches ? sidebar.toggle() : context.openMenu()),
    },
    ...appearanceCommands(settings),
    {
      id: "open-settings",
      title: "Open settings",
      group: "actions",
      icon: "cog-6-tooth",
      keywords: "preferences options configure",
      href: "/settings",
      rank: 20,
    },
    {
      id: "new-project",
      title: "Add project",
      group: "actions",
      icon: "plus",
      keywords: "new create project directory clone git github repository workspace",
      rank: 21,
      run: () => context.addProject.show(),
    },
  ];
}

/** Each project, with a new thread, its settings and its threads inside. */
const projectCommands = (overview: OverviewState, threads: readonly ui.Thread[]): Command[] =>
  overview.projectChoices.map((project) => ({
    id: `project:${project.id}`,
    title: project.name,
    muted: Boolean(overview.projectAway(project)),
    detail: overview.projectAway(project),
    group: "projects",
    projectName: project.name,
    projectKind: project.kind,
    keywords: `project ${project.aliases.join(" ")}`,
    suggested: false,
    placeholder: `Search ${project.name}…`,
    children: () => [
      {
        id: "new-thread",
        title: `New thread in ${project.name}`,
        disabled: Boolean(overview.projectAway(project)),
        detail: overview.projectAway(project),
        group: "actions",
        icon: "pencil-square",
        href: newThreadHref(project),
      },
      {
        id: "settings",
        title: project.kind === "scratch" ? "Thread defaults" : "Project settings",
        group: "actions",
        icon: "cog-6-tooth",
        href: project.kind === "scratch" ? "/settings/threads" : `/settings/projects/${project.id}`,
      },
      ...threads.flatMap((t) => (project.projectIds.includes(t.projectId) ? [threadCommand(overview, t, true)] : [])),
    ],
  }));

/** Actions shared with the thread's row menu; page-only actions live in threadCommands. */
function currentThreadCommands(context: AppCommandContext, thread: ui.Thread | undefined): Command[] {
  const { overview, settings } = context;

  return thread
    ? threadActions(
        thread,
        overview.project(thread.projectId)?.name ?? "project",
        settings.sidebar.pinnedThreadIds.includes(thread.id),
        Boolean(thread.nodeId && awayReason(overview.computer(thread.nodeId))),
      )
        .filter((a) => ["pin", "rename", "archive", "delete", "read", "filter"].includes(a.id))
        .map((a) => ({
          id: `thread-action:${a.id}`,
          title: a.label,
          icon: a.icon,
          disabled: a.disabled,
          group: "actions",
          run: () => context.threadActions.run(a.id, thread),
        }))
    : [];
}

/** Commands of the whole app: new threads, navigation, appearance, settings, every thread and project. */
export function appCommands(context: AppCommandContext): CommandSource {
  const { overview, settings } = context;

  return () => {
    const projectId = context.currentProjectId();

    const current =
      overview.projectChoice(projectId ?? "") ??
      defaultProject({
        projects: overview.projectChoices,
        threads: overview.threads.values(),
        defaultWorkspaceId: settings.threadDefaults.workspaceId,
      });

    const threads = [...overview.threads.values()].sort(byActivity);
    const currentThreadId = context.currentThreadId();
    const actions = actionCommands(context, current);

    // Recent threads: the main threads by activity on an empty query (side threads are found by searching).
    let suggested = 0;

    const threadCommands = threads.map((thread) => {
      const show = !isSide(thread) && thread.id !== currentThreadId && suggested < 8;

      if (show) suggested += 1;

      return threadCommand(overview, thread, show);
    });

    const projects = projectCommands(overview, threads);

    const sections: Command[] = settingsSections
      .filter((section) => context.capabilities.supports(section.href))
      .map((section) => ({
        id: `settings:${section.href}`,
        title: sectionTitles.get(section.href) ?? section.label,
        group: "settings",
        icon: section.icon,
        keywords: `settings ${section.keywords}`,
        href: section.href,
      }));

    const thread = overview.threads.get(currentThreadId ?? "");
    const currentActions = currentThreadCommands(context, thread);

    return [...currentActions, ...actions, ...threadCommands, ...projects, ...sections];
  };
}
