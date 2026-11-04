import { create, equals, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { getContext, setContext } from "svelte";
import { ui } from "@canopy/contracts";
import { HttpError, requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";
import { userTimeZone } from "#lib/shared/ui/date-time.ts";

/** Shown next to the settings: a write that hit a change from elsewhere, or one that failed. */
export interface SettingsNotice {
  readonly tone: "info" | "error";
  readonly text: string;
}

type UserSection = "appearance" | "threadDefaults" | "modelFavorites" | "composer" | "textGeneration" | "sidebar";

const userSchemas = {
  appearance: ui.AppearanceSettingsSchema,
  threadDefaults: ui.ThreadDefaultsSchema,
  modelFavorites: ui.ModelFavoritesSchema,
  composer: ui.ComposerSettingsSchema,
  textGeneration: ui.TextGenerationSettingsSchema,
  sidebar: ui.SidebarSettingsSchema,
} as const;

interface ServerSettings {
  user: ui.UserSettings;
  projects: Map<string, ui.ProjectSettings>;
}

/**
 * The user's and projects' settings. The gateway keeps them (docs/ui-api.md); this is a client of it:
 * loaded through the BFF, changed by writes, and kept current by the overview stream
 * (changes from other devices and tabs).
 *
 * A write replaces one section and names the version it started from. Writes run one at a time; a
 * change shows at once and is applied again on top of whatever the gateway has when it is sent. A
 * conflict (409: changed elsewhere in between) reloads the settings and applies the change once more.
 */
export class SettingsState {
  user = $state.raw<ui.UserSettings>(create(ui.UserSettingsSchema));
  projects = $state.raw<ReadonlyMap<string, ui.ProjectSettings>>(new Map());
  notice = $state<SettingsNotice | undefined>(undefined);
  /** The gateway's attachment limits (the composer checks them before uploading); undefined = defaults. */
  attachmentLimits = $state.raw<ui.AttachmentLimits | undefined>(undefined);
  /** Writes queued or in flight. */
  saving = $state(0);
  #queue: Promise<void> = Promise.resolve();
  #timezoneSynced = false;
  /** What the gateway last confirmed (without changes still being written). */
  #server: ServerSettings = {
    user: create(ui.UserSettingsSchema),
    projects: new Map(),
  };

  constructor(initial: ui.GetSettingsResponse | undefined) {
    if (initial) this.#replace(initial);
  }

  get appearance(): ui.AppearanceSettings {
    return this.user.appearance ?? create(ui.AppearanceSettingsSchema);
  }

  get threadDefaults(): ui.ThreadDefaults {
    return this.user.threadDefaults ?? create(ui.ThreadDefaultsSchema);
  }

  get textGeneration(): ui.TextGenerationSettings {
    return this.user.textGeneration ?? create(ui.TextGenerationSettingsSchema);
  }

  get sidebar(): ui.SidebarSettings {
    return this.user.sidebar ?? create(ui.SidebarSettingsSchema);
  }

  updateSidebar(change: Partial<Omit<ui.SidebarSettings, "$typeName">>): Promise<void> {
    return this.#writeUser("sidebar", (current) => ({ ...current, ...change }));
  }

  pinThread(threadId: string, pinned: boolean): Promise<void> {
    return this.#writeUser("sidebar", (current) => ({
      ...current,
      pinnedThreadIds: pinned
        ? [...new Set([...current.pinnedThreadIds, threadId])]
        : current.pinnedThreadIds.filter((id) => id !== threadId),
    }));
  }

  pinBot(botId: string, pinned: boolean): Promise<void> {
    return this.#writeUser("sidebar", (current) => ({
      ...current,
      pinnedBotIds: pinned
        ? [...new Set([...current.pinnedBotIds, botId])]
        : current.pinnedBotIds.filter((id) => id !== botId),
    }));
  }

  updateTextGeneration(change: Partial<Omit<ui.TextGenerationSettings, "$typeName">>): Promise<void> {
    return this.#writeUser("textGeneration", (current) => ({ ...current, ...change }));
  }

  get modelFavorites(): readonly ui.FavoriteModel[] {
    return this.user.modelFavorites?.models ?? [];
  }

  /** What Enter does in the composer while a turn runs (Mod+Enter does the other). */
  get runningDelivery(): "steer" | "queue" {
    return this.user.composer?.runningDelivery === ui.MessageDelivery.QUEUE ? "queue" : "steer";
  }

  updateRunningDelivery(delivery: "steer" | "queue"): Promise<void> {
    return this.#writeUser("composer", () =>
      create(ui.ComposerSettingsSchema, {
        runningDelivery: delivery === "queue" ? ui.MessageDelivery.QUEUE : ui.MessageDelivery.STEER,
      }),
    );
  }

  projectDefaults(projectId: string): ui.ThreadDefaults {
    return this.projects.get(projectId)?.threadDefaults ?? create(ui.ThreadDefaultsSchema);
  }

  /** A change from the overview stream: newer versions replace what is here. */
  apply(update: ui.OverviewUpdate): void {
    const change = update.change;

    if (change.case === "userSettings" && change.value.version > this.#server.user.version)
      this.#confirmUser(change.value);

    if (change.case === "projectSettings") {
      const known = this.#server.projects.get(change.value.projectId);

      if (!known || change.value.version > known.version) this.#confirmProject(change.value);
    }
  }

  async reload(): Promise<void> {
    this.#replace(decode(ui.GetSettingsResponseSchema, await requestJson("GET", "/api/settings")));
    this.#syncDeviceTimezone();
  }

  /** Once after the first full load; reconnects and stream updates never resync the device zone. */
  #syncDeviceTimezone(): void {
    if (this.#timezoneSynced) return;
    this.#timezoneSynced = true;
    const timezone = userTimeZone();

    if (!timezone || timezone === this.#server.user.timezone) return;
    void this.#enqueue(async () => {
      const before = this.#server.user;

      for (let attempt = 0; ; attempt++) {
        if (timezone === this.#server.user.timezone) return;

        try {
          const body = create(ui.UpdateUserSettingsRequestSchema, {
            timezone,
            expectedVersion: this.#server.user.version,
          });

          const response = await requestJson(
            "PUT",
            "/api/settings/user",
            encode(ui.UpdateUserSettingsRequestSchema, body),
          );

          const saved = decode(ui.UpdateUserSettingsResponseSchema, response).settings;

          if (saved && saved.version > this.#server.user.version) this.#confirmUser(saved);

          return;
        } catch (cause) {
          if (
            !(await this.#retryAfterConflict(
              cause,
              attempt,
              () => this.#server.user,
              before,
              ui.UserSettingsSchema,
              true,
            ))
          )
            return;
        }
      }
    }).catch(() => undefined);
  }

  updateAppearance(
    change: Partial<Omit<MessageShape<typeof ui.AppearanceSettingsSchema>, "$typeName">>,
  ): Promise<void> {
    return this.#writeUser("appearance", (current) => ({ ...current, ...change }));
  }

  updateThreadDefaults(next: ui.ThreadDefaults): Promise<void> {
    return this.#writeUser("threadDefaults", () => next);
  }

  /** The favorite models of the model picker (the whole list, in order). */
  updateModelFavorites(models: readonly ui.FavoriteModel[]): Promise<void> {
    return this.#writeUser("modelFavorites", () => create(ui.ModelFavoritesSchema, { models: [...models] }));
  }

  updateProjectDefaults(projectId: string, next: ui.ThreadDefaults): Promise<void> {
    const show = () => {
      const known = this.projects.get(projectId) ?? create(ui.ProjectSettingsSchema, { projectId });
      this.projects = new Map(this.projects).set(projectId, { ...known, threadDefaults: next });
    };

    show();

    return this.#enqueue(async () => {
      const confirmed = () => this.#server.projects.get(projectId)?.threadDefaults ?? create(ui.ThreadDefaultsSchema);
      const before = confirmed();

      for (let attempt = 0; ; attempt++) {
        show();

        try {
          const body = create(ui.UpdateProjectSettingsRequestSchema, {
            projectId,
            threadDefaults: next,
            expectedVersion: this.#server.projects.get(projectId)?.version ?? 0n,
          });

          const response = await requestJson(
            "PUT",
            `/api/settings/projects/${encodeURIComponent(projectId)}`,
            encode(ui.UpdateProjectSettingsRequestSchema, body),
          );

          const saved = decode(ui.UpdateProjectSettingsResponseSchema, response).settings;

          if (saved) this.#confirmProject(saved);

          return;
        } catch (cause) {
          if (!(await this.#retryAfterConflict(cause, attempt, confirmed, before, ui.ThreadDefaultsSchema))) return;
        }
      }
    });
  }

  dismissNotice(): void {
    this.notice = undefined;
  }

  #writeUser<S extends UserSection>(
    section: S,
    patch: (current: ui.UserSettings[S] & {}) => ui.UserSettings[S] & {},
  ): Promise<void> {
    const schema: DescMessage = userSchemas[section];
    // SAFETY: `userSchemas` lists every section with the message type of that ui.UserSettings field, so a message of
    // `userSchemas[section]` is a value of `ui.UserSettings[S]`.
    const blank = () => create(schema) as ui.UserSettings[S] & {};
    const current = () => this.user[section] ?? blank();
    const confirmed = () => this.#server.user[section] ?? blank();
    const show = () => (this.user = { ...this.user, [section]: patch(current()) });
    show();

    return this.#enqueue(async () => {
      const before = confirmed();

      for (let attempt = 0; ; attempt++) {
        show();

        try {
          const body = create(ui.UpdateUserSettingsRequestSchema, {
            [section]: this.user[section],
            expectedVersion: this.#server.user.version,
          });

          const response = await requestJson(
            "PUT",
            "/api/settings/user",
            encode(ui.UpdateUserSettingsRequestSchema, body),
          );

          const saved = decode(ui.UpdateUserSettingsResponseSchema, response).settings;

          if (saved && saved.version > this.#server.user.version) this.#confirmUser(saved);

          return;
        } catch (cause) {
          if (!(await this.#retryAfterConflict(cause, attempt, confirmed, before, schema))) return;
        }
      }
    });
  }

  /**
   * After a failed write: on the first conflict reload and say so when the section itself changed
   * elsewhere (`section` = what the gateway has now, `before` = what it had when the write started;
   * true = try again); otherwise report the failure and show what the gateway has.
   */
  async #retryAfterConflict<D extends DescMessage>(
    cause: unknown,
    attempt: number,
    section: () => MessageShape<D>,
    before: MessageShape<D>,
    schema: D,
    silent = false,
  ): Promise<boolean> {
    const conflict = cause instanceof HttpError && cause.status === 409;

    try {
      await this.reload();
    } catch {
      // keep what is shown; the stream or the next write catches up
    }

    if (conflict && attempt === 0) {
      if (!silent && !equals(schema, section(), before))
        this.notice = {
          tone: "info",
          text: "These settings were just changed on another device. Your change was applied on top.",
        };

      return true;
    }

    if (!silent)
      this.notice = {
        tone: "error",
        text: `Could not save the change: ${cause instanceof Error ? cause.message : "unknown error"}`,
      };

    return false;
  }

  #enqueue(job: () => Promise<void>): Promise<void> {
    this.saving += 1;
    const run = this.#queue.then(job).finally(() => (this.saving -= 1));
    this.#queue = run.catch(() => undefined);

    return run;
  }

  #confirmUser(settings: ui.UserSettings): void {
    this.#server.user = settings;
    this.user = settings;
  }

  #confirmProject(settings: ui.ProjectSettings): void {
    this.#server.projects.set(settings.projectId, settings);
    this.projects = new Map(this.projects).set(settings.projectId, settings);
  }

  #replace(settings: ui.GetSettingsResponse): void {
    if (settings.attachmentLimits) this.attachmentLimits = settings.attachmentLimits;

    if (settings.user) this.#confirmUser(settings.user);
    this.#server.projects = new Map(settings.projects.map((p) => [p.projectId, p]));
    this.projects = new Map(this.#server.projects);
  }
}

const KEY = Symbol("settings");
export const provideSettings = (state: SettingsState) => setContext(KEY, state);
export const useSettings = () => getContext<SettingsState>(KEY);
