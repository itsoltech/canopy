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

const string = Schema.is(Schema.String);
const boolean = Schema.is(Schema.Boolean);
export const configFieldLabel = (field: string) => LABELS.get(field) ?? "Account setting";

export function configNoticeValue(value: string) {
  if (value === "A different key") return value;
  const parsed = Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(value));

  if (parsed === null) return "Default";

  if (boolean(parsed)) return parsed ? "On" : "Off";

  if (string(parsed)) {
    if (/^[A-Z_]+$/.test(parsed)) {
      const words = parsed
        .replace(
          /^(COLOR_SCHEME|ACCENT_THEME|CHAT_WIDTH|COLOR_THEME|PROJECT_ORDER|MESSAGE_DELIVERY|PERMISSION_MODE|PROVIDER)_/,
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
