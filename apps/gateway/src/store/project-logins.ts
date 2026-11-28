import { create, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { PROJECT_SECRET_NAME_PATTERN } from "@canopy/domain";
import { parseOneTimeCodeSetup } from "@canopy/domain/one-time-codes";
import {
  LOGIN_NOTES_MAX,
  LOGIN_PASSWORD_MAX,
  LOGIN_USERNAME_MAX,
  parseLoginWebsites,
  type ProjectLoginMetadata,
  type ProjectLoginSecret,
  type ProjectLoginValue,
} from "@canopy/domain/project-logins";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid } from "./errors.ts";
import { decryptSecret, encryptSecret, SECRETS_KEY_ID } from "./secrets.ts";

const LoginMetadata = Schema.Struct({
  websites: Schema.Array(Schema.String),
  username: Schema.String,
  show_username: Schema.Boolean,
  notes: Schema.String,
  ask_each_time: Schema.Boolean,
  outside_browser: Schema.Boolean,
  one_time_code: Schema.Boolean,
});

const LoginSecret = Schema.Struct({
  password: Schema.String,
  one_time_code_setup: Schema.optionalKey(Schema.String),
});

const decodeMetadata = Schema.decodeUnknownSync(LoginMetadata);
const decodeSecret = Schema.decodeUnknownSync(Schema.fromJsonString(LoginSecret));
const SETUP_MAX = 2048;

export function loginMetadata(value: JsonValue): ProjectLoginMetadata {
  const parsed = decodeMetadata(value);

  return { ...parsed, websites: [...parsed.websites] };
}

export function toUiLogin(metadata: ProjectLoginMetadata): ui.ProjectLogin {
  return create(ui.ProjectLoginSchema, {
    websites: metadata.websites,
    username: metadata.username,
    showUsername: metadata.show_username,
    notes: metadata.notes,
    askEachTime: metadata.ask_each_time,
    outsideBrowser: metadata.outside_browser,
    oneTimeCode: metadata.one_time_code,
  });
}

/** What the agent may read about a login: never the password, and the username only when shown. */
export function agentLogin(name: string, metadata: ProjectLoginMetadata) {
  return {
    name,
    websites: metadata.websites,
    username: metadata.show_username ? metadata.username : "hidden",
    one_time_code: metadata.one_time_code,
    outside_browser: metadata.outside_browser,
    ask_each_time: metadata.ask_each_time,
    ...(metadata.notes && { notes: metadata.notes }),
  };
}

/** The value a worker or an outside-browser file receives. */
export function loginValue(key: Buffer, name: string, metadata: ProjectLoginMetadata, ciphertext: Uint8Array): string {
  const secret = decodeSecret(decryptSecret(key, ciphertext));

  const value: ProjectLoginValue = {
    name,
    username: metadata.username,
    password: secret.password,
    websites: metadata.websites,
    hide_username: !metadata.show_username,
    ...(secret.one_time_code_setup && { one_time_code_setup: secret.one_time_code_setup }),
  };

  return JSON.stringify(value);
}

function invalid(message: string) {
  return Effect.fail(new Invalid(message));
}

interface LoginInput {
  name: string;
  login: ui.ProjectLogin | undefined;
  password: string | undefined;
  setup: string | undefined;
}

function validText(value: string, max: number) {
  return value.length <= max && !value.includes("\0");
}

function validate({ name, login, password, setup }: LoginInput) {
  return Effect.gen(function* () {
    if (!PROJECT_SECRET_NAME_PATTERN.test(name))
      return yield* invalid(
        "use a login name of up to 128 letters, digits or underscores, starting with a letter or underscore",
      );

    if (!login) return yield* invalid("provide the login details");
    const websites = parseLoginWebsites(login.websites);

    if (!websites) return yield* invalid("add 1–20 websites, such as https://app.example.com");

    if (!validText(login.username, LOGIN_USERNAME_MAX) || !validText(login.notes, LOGIN_NOTES_MAX))
      return yield* invalid("shorten the username or the notes");

    if (password !== undefined && (!password || !validText(password, LOGIN_PASSWORD_MAX)))
      return yield* invalid("provide a password of 1–8192 characters without NUL");

    if (setup && (setup.length > SETUP_MAX || !parseOneTimeCodeSetup(setup)))
      return yield* invalid("use a base32 setup key or an otpauth://totp link");

    return { ...login, websites };
  });
}

type LoginRow = { name: string; updated_at: Date; login: JsonValue };

/** Insert or update one login. A missing password or setup key keeps the saved one. */
export function writeLogin(sql: SqlClient.SqlClient, key: Buffer, projectId: string, input: LoginInput) {
  return Effect.gen(function* () {
    const login = yield* validate(input);

    const taken = yield* sql`SELECT 1 FROM project_secrets WHERE project_id=${projectId}::uuid AND name=${input.name}`;

    if (taken.length) return yield* invalid("a project secret already uses this name; choose another name");

    const [existing] = yield* sql<{ ciphertext: Uint8Array }>`SELECT ciphertext FROM project_logins
      WHERE project_id=${projectId}::uuid AND name=${input.name} FOR UPDATE`;

    const previous: ProjectLoginSecret | undefined = existing
      ? decodeSecret(decryptSecret(key, existing.ciphertext))
      : undefined;

    const password = input.password ?? previous?.password;

    if (!password) return yield* invalid("provide a password for the new login");
    const setup = input.setup === undefined ? previous?.one_time_code_setup : input.setup.trim();
    const secret: ProjectLoginSecret = { password, ...(setup && { one_time_code_setup: setup }) };

    const metadata: ProjectLoginMetadata = {
      websites: login.websites,
      username: login.username,
      show_username: login.showUsername,
      notes: login.notes.trim(),
      ask_each_time: login.askEachTime,
      outside_browser: login.outsideBrowser,
      one_time_code: Boolean(setup),
    };

    const ciphertext = encryptSecret(key, JSON.stringify(secret));

    return yield* sql<LoginRow>`INSERT INTO project_logins(project_id,name,ciphertext,key_id,login)
      VALUES (${projectId}::uuid,${input.name},${ciphertext},${SECRETS_KEY_ID},${JSON.stringify(metadata)}::jsonb)
      ON CONFLICT(project_id,name) DO UPDATE SET ciphertext=excluded.ciphertext, key_id=excluded.key_id,
        login=excluded.login, updated_at=statement_timestamp()
      RETURNING name,updated_at,login`;
  });
}
