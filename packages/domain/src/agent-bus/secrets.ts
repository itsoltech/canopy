import { Schema } from "effect";

export const PROJECT_SECRET_LEASES = "project_secret_leases_v1";
export const PROJECT_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const PROJECT_SECRET_MAX_BYTES = 32768;

export const ListProjectSecrets = Schema.Struct({});

export const RequestSecret = Schema.Struct({
  label: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  description: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000))),
  placeholder: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  name: Schema.optionalKey(Schema.String.check(Schema.isPattern(PROJECT_SECRET_NAME_PATTERN))),
  project_secret: Schema.optionalKey(Schema.String.check(Schema.isPattern(PROJECT_SECRET_NAME_PATTERN))),
  request_id: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
});

export const SECRET_TOOLS = {
  list_project_secrets: {
    name: "list_project_secrets",
    description:
      "List the secrets and logins the owner has configured in this thread's project. Returns secret names, and for logins " +
      "their websites, username (unless hidden), notes and whether they have a one-time code. Never returns values. " +
      "Sign in to a login's website with agent_browser_fill_login and agent_browser_fill_one_time_code.",
    args: ListProjectSecrets,
    mutates: false,
  },
  request_secret: {
    name: "request_secret",
    description:
      "Use project_secret with a name from list_project_secrets to request a file through the end of this turn, for at most 15 minutes. " +
      "A login marked outside_browser gives a JSON file with username, password and one_time_code_setup; other logins work only in Agent Browser. " +
      "For a manual request, provide label and description to ask the user in a private card. Never ask for secrets in chat. " +
      "Returns only a private file path on this thread's worker, never the value. Read it inside a command, e.g. " +
      "TOKEN=\"$(cat '<file>')\" program; never print, echo, log or read the value into model context. " +
      "A manually provided secret is available for 24 hours unless revoked. name is an optional env name hint. " +
      "If pending, call again with the returned request_id and the same metadata. Secrets are per thread; children must ask separately.",
    args: RequestSecret,
    mutates: true,
  },
} as const;

export function requestSecretProblem(args: typeof RequestSecret.Type): string | undefined {
  if (!args.project_secret)
    return args.label && args.description ? undefined : "provide label and description for a manual request";

  return args.label !== undefined ||
    args.description !== undefined ||
    args.placeholder !== undefined ||
    args.name !== undefined
    ? "use project_secret and optionally request_id for a project secret"
    : undefined;
}
