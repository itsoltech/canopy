import { Schema } from "effect";

const LABELS = new Map(
  Object.entries({
    timezone: "Time zone",
    "appearance.colorScheme": "Color scheme",
    "appearance.accent": "Accent",
    "appearance.chatWidth": "Thread width",
    "appearance.lightTheme": "Light theme",
    "appearance.darkTheme": "Dark theme",
    "general.confirmUnpin": "Confirm unpin",
    "general.confirmArchive": "Confirm archive",
    "general.confirmDelete": "Confirm delete",
    "composer.runningDelivery": "Enter during a turn",
    "cliUpdates.intervalMinutes": "CLI update checks",
    "threadDefaults.provider": "Default provider",
    "threadDefaults.providerProfileId": "Default instance",
    "threadDefaults.permissionMode": "Default permissions",
    "threadDefaults.models": "Default models",
    "textGeneration.provider": "Text generation provider",
    "textGeneration.profileId": "Text generation instance",
    "textGeneration.model": "Text generation model",
    "textGeneration.effort": "Text generation effort",
    "textGeneration.threadTitleInstructions": "Thread title instructions",
    "sidebar.pinnedThreadIds": "Pinned threads",
    "sidebar.pinnedBotIds": "Pinned bots",
    "sidebar.projectIds": "Sidebar projects",
    "sidebar.archivedExpanded": "Archived projects",
    "sidebar.groupByProject": "Group by project",
    "sidebar.projectOrder": "Project order",
    "sidebar.workingSection": "Working section",
    deleted: "Deleted configuration",
  }),
);

const ITEM_LABELS = new Map(
  Object.entries({
    label: "Name",
    name: "Name",
    kind: "Connects with",
    baseUrl: "Endpoint",
    proxy: "Proxy",
    accentColor: "Color",
    launchArgs: "Launch arguments",
    ownLogin: "Own login",
    allWorkers: "All workers",
    favorites: "Favorite models",
    hidden: "Hidden models",
    shown: "Shown models",
    custom: "Custom models",
    apiKey: "API key",
    secret: "Secret",
    codex: "Codex options",
    deleted: "Deleted",
  }),
);

const PROXY_LABELS = new Map(Object.entries({ kind: "Kind", baseUrl: "Base URL" }));

const CONNECTOR_LABELS = new Map(
  Object.entries({
    type: "Connector",
    name: "Name",
    url: "Endpoint",
    transport: "Transport",
    authKind: "Sign-in method",
    allWorkers: "All workers",
    allBots: "All bots",
    tools: "Tools",
    accountIdentity: "Account",
    credentials: "Credentials",
    deleted: "Deleted",
  }),
);

const PROJECT_LABELS = new Map(
  Object.entries({
    name: "Name",
    kind: "Kind",
    archived: "Archived",
    origin: "Git origin",
    deleted: "Deleted",
  }),
);

const POLICY_LABELS = new Map(
  Object.entries({
    startFromRemote: "Start from remote",
    remote: "Remote",
    branchNaming: "Branch naming",
    branchPrefix: "Branch prefix",
    defaultMode: "Default workspace",
    cleanupDeletedThreads: "Deleted threads",
    cleanupMerged: "Merged branches",
    cleanupInactiveDays: "Inactive for days",
    cleanupSettled: "Settled threads",
    cleanupUnchanged: "Unchanged worktrees",
    keepLocalChanges: "Keep worktrees with local changes",
    deleteLocalBranch: "Delete safe local branches",
    deleted: "Deleted",
  }),
);

const ENVIRONMENT_LABELS = new Map(
  Object.entries({
    name: "Name",
    harness: "Agent file",
    selector: "Assignment",
    fragments: "Fragments",
    deviceHome: "Device CLI",
    platformHome: "Canopy agent sessions",
    harnesses: "Harnesses",
    source: "Source",
    autoUpdate: "Automatic updates",
    pinned: "Pinned version",
    selected: "Version",
    catalog: "Catalog",
    marketplace: "Marketplace",
    deleted: "Deleted",
  }),
);

const ENVIRONMENT_KINDS = new Set(["instruction", "skill", "marketplace", "plugin"]);

/** Library values that are references or content: named, never shown as hashes or raw JSON. */
const ENVIRONMENT_VALUES = new Map(
  Object.entries({
    selector: "A different assignment",
    fragments: "Different fragments",
    selected: "A different version",
    catalog: "A different catalog",
    source: "A different source",
    harnesses: "Different harnesses",
  }),
);

const string = Schema.is(Schema.String);
const boolean = Schema.is(Schema.Boolean);

export function configFieldLabel(field: string, kind = "settings") {
  if (kind === "connector" || kind === "oauth_app") return CONNECTOR_LABELS.get(field) ?? "Connector setting";

  if (kind === "settings" || kind === "project_settings") return LABELS.get(field) ?? "Setting";

  if (kind === "project")
    return (field.startsWith("originAmbiguous.") ? "Git origin" : PROJECT_LABELS.get(field)) ?? "Project setting";

  if (kind === "worktree_policy") return POLICY_LABELS.get(field) ?? "Worktree setting";

  if (ENVIRONMENT_KINDS.has(kind))
    return field.startsWith("version.") ? "Version" : (ENVIRONMENT_LABELS.get(field) ?? "Library setting");

  if (field.startsWith("env.")) return `Variable ${field.slice(4)}`;

  return (kind === "proxy" ? PROXY_LABELS.get(field) : undefined) ?? ITEM_LABELS.get(field) ?? "Setting";
}

const object = Schema.is(Schema.Record(Schema.String, Schema.MutableJson));
const plainVariable = Schema.is(Schema.Struct({ value: Schema.String }));

/** Instance and proxy values: references and options are named, never shown as raw ids. */
export function configItemValue(field: string, value: string) {
  if (value === "A different key") return value;
  const parsed = Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(value));

  if (field === "proxy") return parsed ? "A different proxy" : "No proxy";

  if (field === "accountIdentity") return parsed ? "A different account" : "Not set";

  const named = ENVIRONMENT_VALUES.get(field) ?? (field.startsWith("version.") ? "A different version" : undefined);

  if (named) return parsed === null ? "Not set" : named;

  if (field === "kind" && (parsed === "endpoint" || parsed === "native"))
    return parsed === "endpoint" ? "Endpoint" : "Device login";

  if (plainVariable(parsed)) return parsed.value || "Empty";

  if (object(parsed)) return "Different options";

  if (parsed === null) return "Not set";

  return configNoticeValue(value);
}

export function configNoticeValue(value: string) {
  if (value === "A different key") return value;
  const parsed = Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(value));

  if (parsed === null) return "Default";

  if (boolean(parsed)) return parsed ? "On" : "Off";

  if (string(parsed)) {
    if (/^[A-Z_]+$/.test(parsed)) {
      const words = parsed
        .replace(
          /^(COLOR_SCHEME|ACCENT_THEME|CHAT_WIDTH|COLOR_THEME|PROJECT_ORDER|MESSAGE_DELIVERY|PERMISSION_MODE|PROVIDER|WORKSPACE_MODE|BRANCH_NAMING)_/,
          "",
        )
        .toLowerCase()
        .replaceAll("_", " ");

      return words.charAt(0).toUpperCase() + words.slice(1);
    }

    return parsed || "Default";
  }

  return Array.isArray(parsed) ? "A different list" : String(parsed);
}
