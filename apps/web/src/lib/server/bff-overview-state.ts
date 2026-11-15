import { clone, create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { forgetComputerProjects, replaceComputerProjects, replaceComputerRows } from "@canopy/domain/linked-snapshot";
import { latestThreadChoices } from "@canopy/domain/new-thread-choices";

function upsert<T extends { id: string }>(items: readonly T[], value: T, key: (item: T) => string): T[] {
  const index = items.findIndex((item) => key(item) === key(value));

  return index >= 0 ? items.with(index, value) : [...items, value];
}

function replaceBy<T>(items: readonly T[], value: T, key: (item: T) => string): T[] {
  const index = items.findIndex((item) => key(item) === key(value));

  return index >= 0 ? items.with(index, value) : [...items, value];
}

/** Owner-scoped overview, thread index and settings projection. It is cleared before every upstream epoch. */
export class BffOverviewState {
  readonly #computers = new Map<string, ui.LinkedComputer>();
  readonly #threads = new Map<string, ui.Thread>();
  #workers: ui.Worker[] = [];
  #projects: ui.Project[] = [];
  #agents: ui.Agent[] = [];
  #lastUsedAgent: ui.Thread | undefined;
  #overview: ui.GetOverviewResponse | undefined;
  #settings: ui.GetSettingsResponse | undefined;
  #feeds: ui.OverviewFeeds | undefined;
  #hasSnapshot = false;

  get hasSnapshot(): boolean {
    return this.#hasSnapshot;
  }

  get feeds(): ui.OverviewFeeds | undefined {
    return this.#feeds && clone(ui.OverviewFeedsSchema, this.#feeds);
  }

  reset(): void {
    this.#overview = undefined;
    this.#settings = undefined;
    this.#feeds = undefined;
    this.#computers.clear();
    this.#threads.clear();
    this.#workers = [];
    this.#projects = [];
    this.#agents = [];
    this.#lastUsedAgent = undefined;
    this.#hasSnapshot = false;
  }

  overview(): ui.GetOverviewResponse {
    return clone(ui.GetOverviewResponseSchema, this.#overview!);
  }

  threads(projectId = ""): ui.ListThreadsResponse {
    return create(ui.ListThreadsResponseSchema, {
      threads: [...this.#threads.values()].flatMap((thread) =>
        !projectId || thread.projectId === projectId ? [clone(ui.ThreadSchema, thread)] : [],
      ),
    });
  }

  thread(id: string): ui.Thread | undefined {
    const thread = this.#threads.get(id);

    return thread ? clone(ui.ThreadSchema, thread) : undefined;
  }

  settings(): ui.GetSettingsResponse {
    return clone(ui.GetSettingsResponseSchema, this.#settings ?? create(ui.GetSettingsResponseSchema));
  }

  snapshotUpdate(): ui.OverviewUpdate {
    const snapshot = create(ui.MobileOverviewSnapshotSchema, {
      overview: clone(ui.GetOverviewResponseSchema, this.#overview!),
      threads: [...this.#threads.values()].map((thread) => clone(ui.ThreadSchema, thread)),
    });

    if (this.#settings) snapshot.settings = clone(ui.GetSettingsResponseSchema, this.#settings);

    return create(ui.OverviewUpdateSchema, {
      change: { case: "mobileSnapshot", value: snapshot },
    });
  }

  apply(update: ui.OverviewUpdate): void {
    const change = update.change;

    if (change.case === "mobileSnapshot") {
      if (!change.value.overview) throw new Error("BFF overview snapshot is missing its overview");
      this.#installSnapshot(change.value);

      return;
    }

    if (!this.#hasSnapshot) return;

    switch (change.case) {
      case "feeds":
        this.#feeds = clone(ui.OverviewFeedsSchema, change.value);
        break;
      case "worker":
        this.#workers = upsert(this.#workers, clone(ui.WorkerSchema, change.value), (worker) => worker.id);
        this.#rebuildOverview();
        break;
      case "workerRemoved":
        this.#workers = this.#workers.filter((worker) => worker.id !== change.value);
        this.#rebuildOverview();
        break;
      case "project":
        this.#projects = change.value.archivedAt
          ? this.#projects.filter((project) => project.id !== change.value.id)
          : upsert(this.#projects, clone(ui.ProjectSchema, change.value), (project) => project.id);
        this.#rebuildOverview();
        break;
      case "thread":
        if (change.value.deletedAt) {
          this.#threads.delete(change.value.id);

          if (this.#lastUsedAgent?.id === change.value.id) this.#lastUsedAgent = undefined;
        } else {
          this.#threads.set(change.value.id, clone(ui.ThreadSchema, change.value));

          if (change.value.lastUserTurnChoices)
            this.#lastUsedAgent = latestThreadChoices([
              ...(this.#lastUsedAgent ? [this.#lastUsedAgent] : []),
              ...this.#threads.values(),
            ]);
        }

        this.#rebuildOverview();
        break;
      case "computer":
        this.#computers.set(change.value.nodeId, clone(ui.LinkedComputerSchema, change.value));
        this.#rebuildOverview();
        break;
      case "computerRemoved":
        this.#removeComputer(change.value);
        break;
      case "computerSnapshot":
        this.#replaceComputer(change.value);
        break;
      case "userSettings":
        if ((this.#settings?.user?.version ?? -1n) > change.value.version) break;
        this.#settings = clone(ui.GetSettingsResponseSchema, this.#settings ?? create(ui.GetSettingsResponseSchema));
        this.#settings.user = clone(ui.UserSettingsSchema, change.value);

        if (change.value.attachmentLimits)
          this.#settings.attachmentLimits = clone(ui.AttachmentLimitsSchema, change.value.attachmentLimits);
        break;
      case "projectSettings": {
        const settings = clone(ui.GetSettingsResponseSchema, this.#settings ?? create(ui.GetSettingsResponseSchema));
        const current = settings.projects.find((project) => project.projectId === change.value.projectId);

        if (current && current.version > change.value.version) break;
        settings.projects = replaceBy(
          settings.projects,
          clone(ui.ProjectSettingsSchema, change.value),
          (project) => project.projectId,
        );
        this.#settings = settings;
        break;
      }
    }
  }

  #installSnapshot(snapshot: ui.MobileOverviewSnapshot): void {
    const overview = snapshot.overview!;
    this.#overview = clone(ui.GetOverviewResponseSchema, overview);
    this.#workers = overview.workers.map((worker) => clone(ui.WorkerSchema, worker));
    this.#projects = overview.projects.map((project) => clone(ui.ProjectSchema, project));
    this.#agents = overview.agents.map((agent) => clone(ui.AgentSchema, agent));
    this.#lastUsedAgent = overview.lastUsedAgent ? clone(ui.ThreadSchema, overview.lastUsedAgent) : undefined;
    this.#computers.clear();

    for (const computer of overview.computers)
      this.#computers.set(computer.nodeId, clone(ui.LinkedComputerSchema, computer));
    this.#threads.clear();

    for (const thread of snapshot.threads)
      if (!thread.deletedAt) this.#threads.set(thread.id, clone(ui.ThreadSchema, thread));
    this.#settings = snapshot.settings ? clone(ui.GetSettingsResponseSchema, snapshot.settings) : undefined;
    this.#hasSnapshot = true;
  }

  #replaceComputer(snapshot: ui.LinkedComputerSnapshot): void {
    const nodeId = snapshot.nodeId;
    const overview = snapshot.overview;
    this.#workers = replaceComputerRows(this.#workers, overview?.workers ?? [], nodeId).map((worker) =>
      clone(ui.WorkerSchema, worker),
    );
    this.#projects = replaceComputerProjects(this.#projects, overview?.projects ?? [], nodeId).map((project) =>
      clone(ui.ProjectSchema, project),
    );
    const current = [...this.#threads.values()].filter((thread) => thread.nodeId !== nodeId);
    this.#threads.clear();

    for (const thread of [...current, ...snapshot.threads])
      if (!thread.deletedAt) this.#threads.set(thread.id, clone(ui.ThreadSchema, thread));
    this.#lastUsedAgent = latestThreadChoices([
      ...(this.#lastUsedAgent?.nodeId !== nodeId && this.#lastUsedAgent ? [this.#lastUsedAgent] : []),
      ...(overview?.lastUsedAgent ? [overview.lastUsedAgent] : []),
    ]);
    this.#rebuildOverview();
  }

  #removeComputer(nodeId: string): void {
    this.#computers.delete(nodeId);
    this.#workers = this.#workers.filter((worker) => worker.nodeId !== nodeId);
    this.#projects = forgetComputerProjects(this.#projects, nodeId);

    for (const [id, thread] of this.#threads) if (thread.nodeId === nodeId) this.#threads.delete(id);

    if (this.#lastUsedAgent?.nodeId === nodeId) this.#lastUsedAgent = undefined;
    this.#rebuildOverview();
  }

  #rebuildOverview(): void {
    const current = this.#overview ?? create(ui.GetOverviewResponseSchema);

    const overview = create(ui.GetOverviewResponseSchema, {
      workers: this.#workers.map((worker) => clone(ui.WorkerSchema, worker)),
      projects: this.#projects.map((project) => clone(ui.ProjectSchema, project)),
      agents: this.#agents.length ? this.#agents.map((agent) => clone(ui.AgentSchema, agent)) : current.agents,
      computers: [...this.#computers.values()].map((computer) => clone(ui.LinkedComputerSchema, computer)),
    });

    if (this.#lastUsedAgent) overview.lastUsedAgent = clone(ui.ThreadSchema, this.#lastUsedAgent);
    this.#overview = overview;
  }
}
