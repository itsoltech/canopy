import type { ui } from "@canopy/contracts";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import { accentLabels, accentNames, accentOf, chatWidthLabels, chatWidthNames, chatWidthOf, schemeLabels, schemeNames, schemeOf } from "#lib/features/settings/appearance.ts";
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

/** New thread in the current project (Mod+N and Mod+Shift+N belong to the browser: new window, private window). */
export const NEW_THREAD_HOTKEY = "Mod+Shift+O";

export interface AppCommandContext {
  readonly overview: OverviewState;
  readonly settings: SettingsState;
  readonly sidebar: SidebarLayout;
  readonly threadActions: ThreadActions;
  /** Opens the navigation drawer (narrow screens, where the sidebar is not shown). */
  readonly openMenu: () => void;
  /** The project of the page (a thread's, the new-thread page's pick), if any. */
  readonly currentProjectId: () => string | undefined;
  readonly currentThreadId: () => string | undefined;
}

const newThreadHref = (project: ui.Project) => `/?project=${encodeURIComponent(project.id)}`;

/** Palette titles of the settings sections ("Threads" alone would read as the thread list). */
const sectionTitles: Record<string, string> = { "/settings/threads": "Thread defaults" };

/** Commands of the whole app: new threads, navigation, appearance, settings, every thread and project. */
export function appCommands(context: AppCommandContext): CommandSource {
  const { overview, settings, sidebar } = context;

  const threadCommand = (thread: ui.Thread, suggested: boolean): Command => {
    const project = overview.project(thread.projectId);
    const worker = overview.worker(thread.workerId);
    return {
      id: `thread:${thread.id}`,
      title: thread.title || "New thread",
      group: "threads",
      href: `/threads/${thread.id}`,
      keywords: [project?.name, worker?.name, basename(thread.cwd)].filter(Boolean).join(" "),
      suggested,
      thread: { projectName: project?.name ?? "Unknown project", projectKind: project?.kind, workerName: worker?.name ?? "Unknown worker", provider: providerKeyOf(thread.provider), activityAt: activityOf(thread) },
    };
  };

  return () => {
    const projectId = context.currentProjectId();
    const current =
      overview.project(projectId ?? "") ??
      defaultProject({ projects: overview.projects, threads: overview.threads.values(), defaultWorkspaceId: settings.threadDefaults.workspaceId });
    const threads = [...overview.threads.values()].sort(byActivity);
    const currentThreadId = context.currentThreadId();
    const appearance = settings.appearance;

    const actions: Command[] = [
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
        when: () => overview.projects.length > 1,
        children: () =>
          overview.projects.map((project) => ({ id: project.id, title: project.name, group: "actions", projectName: project.name, projectKind: project.kind, href: newThreadHref(project), checked: project.id === current?.id })),
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
      {
        id: "theme",
        title: "Change theme",
        group: "actions",
        icon: "swatch",
        keywords: "accent color colour",
        placeholder: "Search themes…",
        rank: 11,
        searchChildren: true,
        children: () =>
          (Object.keys(accentNames) as (keyof typeof accentNames)[]).map((name) => ({
            id: name,
            title: accentLabels[name],
            group: "actions",
            keywords: "theme accent",
            checked: accentOf(appearance) === name,
            run: () => void settings.updateAppearance({ accent: accentNames[name] }),
          })),
      },
      {
        id: "appearance",
        title: "Change appearance",
        group: "actions",
        icon: schemeOf(appearance) === "dark" ? "moon" : "sun",
        keywords: "color scheme dark light mode system",
        placeholder: "Search appearances…",
        rank: 12,
        searchChildren: true,
        children: () =>
          (Object.keys(schemeNames) as (keyof typeof schemeNames)[]).map((name) => ({
            id: name,
            title: schemeLabels[name],
            group: "actions",
            icon: name === "dark" ? "moon" : name === "light" ? "sun" : "computer-desktop",
            keywords: "appearance color scheme mode",
            checked: schemeOf(appearance) === name,
            run: () => void settings.updateAppearance({ colorScheme: schemeNames[name] }),
          })),
      },
      {
        id: "chat-width",
        title: "Chat width",
        group: "actions",
        icon: "view-columns",
        keywords: "conversation layout wide narrow",
        rank: 13,
        searchChildren: true,
        children: () =>
          (Object.keys(chatWidthNames) as (keyof typeof chatWidthNames)[]).map((name) => ({
            id: name,
            title: chatWidthLabels[name],
            group: "actions",
            keywords: "chat width",
            checked: chatWidthOf(appearance) === name,
            run: () => void settings.updateAppearance({ chatWidth: chatWidthNames[name] }),
          })),
      },
      { id: "open-settings", title: "Open settings", group: "actions", icon: "cog-6-tooth", keywords: "preferences options configure", href: "/settings", rank: 20 },
      { id: "new-project", title: "New project", group: "actions", icon: "plus", keywords: "create add project", href: "/settings/projects", rank: 21 },
    ];

    // Recent threads: the main threads by activity on an empty query (side threads are found by searching).
    let suggested = 0;
    const threadCommands = threads.map((thread) => {
      const show = !isSide(thread) && thread.id !== currentThreadId && suggested < 8;
      if (show) suggested += 1;
      return threadCommand(thread, show);
    });

    const projects: Command[] = overview.projects.map((project) => ({
      id: `project:${project.id}`,
      title: project.name,
      group: "projects",
      projectName: project.name,
      projectKind: project.kind,
      keywords: "project",
      suggested: false,
      placeholder: `Search ${project.name}…`,
      children: () => [
        { id: "new-thread", title: `New thread in ${project.name}`, group: "actions", icon: "pencil-square", href: newThreadHref(project) },
        { id: "settings", title: project.kind === "scratch" ? "Thread defaults" : "Project settings", group: "actions", icon: "cog-6-tooth", href: project.kind === "scratch" ? "/settings/threads" : `/settings/projects/${project.id}` },
        ...threads.filter((t) => t.projectId === project.id).map((t) => threadCommand(t, true)),
      ],
    }));

    const sections: Command[] = settingsSections.map((section) => ({
      id: `settings:${section.href}`,
      title: sectionTitles[section.href] ?? section.label,
      group: "settings",
      icon: section.icon,
      keywords: `settings ${section.keywords}`,
      href: section.href,
    }));

    const thread = overview.threads.get(currentThreadId ?? "");
    const currentActions: Command[] = thread ? threadActions(thread, overview.project(thread.projectId)?.name ?? "project", settings.sidebar.pinnedThreadIds.includes(thread.id), Boolean(thread.nodeId && awayReason(overview.computer(thread.nodeId))))
      .filter((a) => ["pin", "rename", "archive", "delete", "read", "filter"].includes(a.id))
      .map((a) => ({ id: `thread-action:${a.id}`, title: a.label, icon: a.icon, disabled: a.disabled, group: "actions", run: () => context.threadActions.run(a.id, thread) })) : [];
    if (thread) currentActions.push({ id: "thread-action:copy-link", title: "Copy thread link", icon: "link", group: "actions", run: () => context.threadActions.copy(context.threadActions.link(thread)) });
    return [...currentActions, ...actions, ...threadCommands, ...projects, ...sections];
  };
}
