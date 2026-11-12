/** Shared wording for the web, desktop and native bot settings. */
export const BOT_APPROVAL_OPTIONS: { value: "safe" | "always" | "full_auto"; label: string; description: string }[] = [
  {
    value: "safe",
    label: "For actions that need care",
    description: "Connected account writes and sensitive actions ask first unless a rule allows them.",
  },
  {
    value: "always",
    label: "For every action",
    description: "Actions ask first unless a rule allows them. Platform reads run directly.",
  },
  {
    value: "full_auto",
    label: "Only protected actions (full auto)",
    description: "Other actions run without asking. Protected actions and questions still need you.",
  },
];

export const BOT_THREAD_PERMISSION_OPTIONS = [
  {
    value: "user_default",
    label: "Inherit default",
    description: "Uses your default permissions from Settings → Threads.",
  },
  { value: "ask", label: "Ask first", description: "The agent asks before running tools that need approval." },
  {
    value: "read_only",
    label: "Read only",
    description: "The agent can read but cannot change files or connected accounts.",
  },
  {
    value: "accept_edits",
    label: "Accept edits",
    description: "File edits run directly. Other sensitive tools ask first.",
  },
  {
    value: "full_auto",
    label: "Full auto",
    description: "Thread tools run without asking, within the agent’s sandbox.",
  },
  {
    value: "full_access",
    label: "Full access",
    description: "Thread tools run without asking or a sandbox, where the computer allows it.",
  },
];
