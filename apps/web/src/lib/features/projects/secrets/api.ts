import { ui } from "@canopy/contracts";
import { HttpError, requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";

/** The answer to a failed save whose cause is not a gateway validation message. */
export const SAVE_RETRY = "Could not save the secret. Enter it again to retry.";

const path = (projectId: string, name?: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/secrets${name === undefined ? "" : `/${encodeURIComponent(name)}`}`;

export async function listProjectSecrets(projectId: string): Promise<ui.ProjectSecret[]> {
  return decode(ui.ListProjectSecretsResponseSchema, await requestJson("GET", path(projectId))).secrets;
}

/**
 * Write only: no drafts, retries, telemetry or diagnostic payloads at this boundary. The BFF answers with a
 * gateway validation message or a fixed one, never with the request.
 */
export async function putProjectSecret(projectId: string, name: string, value: string): Promise<ui.ProjectSecret> {
  try {
    const secret = decode(
      ui.PutProjectSecretResponseSchema,
      await requestJson("PUT", path(projectId, name), { value }),
    ).secret;

    if (!secret) throw new Error("missing secret");

    return secret;
  } catch (cause) {
    throw new Error(cause instanceof HttpError && cause.status < 500 ? cause.message : SAVE_RETRY);
  }
}

export const LOGIN_SAVE_RETRY = "Could not save the login. Enter the password again to retry.";

export type LoginInput = {
  websites: string[];
  username: string;
  showUsername: boolean;
  notes: string;
  askEachTime: boolean;
  outsideBrowser: boolean;
  /** Omitted: keep the saved password. */
  password?: string;
  /** Omitted: keep it; empty: remove it. */
  oneTimeCodeSetup?: string;
};

/** Write only, like putProjectSecret: the password and setup key are never stored or echoed in the client. */
export async function putProjectLogin(projectId: string, name: string, login: LoginInput): Promise<ui.ProjectSecret> {
  try {
    const secret = decode(
      ui.PutProjectSecretResponseSchema,
      await requestJson(
        "PUT",
        `/api/projects/${encodeURIComponent(projectId)}/logins/${encodeURIComponent(name)}`,
        login,
      ),
    ).secret;

    if (!secret) throw new Error("missing login");

    return secret;
  } catch (cause) {
    throw new Error(cause instanceof HttpError && cause.status < 500 ? cause.message : LOGIN_SAVE_RETRY);
  }
}

export async function deleteProjectSecret(projectId: string, name: string): Promise<void> {
  await requestJson("DELETE", path(projectId, name));
}
