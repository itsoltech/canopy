import { randomBytes } from "node:crypto";
import { error, json } from "@sveltejs/kit";
import { github } from "@canopy/contracts";
import { readMessage } from "#lib/server/body.ts";
import { call } from "#lib/server/gateway.ts";
import { encode } from "#lib/shared/wire.ts";
import type { RequestHandler } from "./$types";

/** Only public DTOs cross the BFF. The browser binding lives in an HttpOnly cookie. */
export const POST: RequestHandler = async ({ params, request, cookies, url }) => {
  let binding = cookies.get("canopy-github-client");

  if (!binding || !/^[A-Za-z0-9_-]{43}$/.test(binding)) {
    binding = randomBytes(32).toString("base64url");
    cookies.set("canopy-github-client", binding, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      maxAge: 31_536_000,
    });
  }

  const options = { headers: { "canopy-github-client": binding }, timeoutMs: 120_000 };

  const result = await call(async (api) => {
    switch (params.operation) {
      case "accounts":
        return encode(
          github.GitHubAccountsResponseSchema,
          await api.listGitHubAccounts(await readMessage(request, github.GitHubAccountsRequestSchema), options),
        );
      case "begin":
        return encode(
          github.GitHubDeviceAuthResponseSchema,
          await api.beginGitHubDeviceAuth(
            await readMessage(request, github.BeginGitHubDeviceAuthRequestSchema),
            options,
          ),
        );
      case "status":
        return encode(
          github.GitHubDeviceAuthResponseSchema,
          await api.getGitHubDeviceAuth(await readMessage(request, github.GitHubDeviceAuthRequestSchema), options),
        );
      case "cancel":
        return encode(
          github.GitHubDeviceAuthResponseSchema,
          await api.cancelGitHubDeviceAuth(await readMessage(request, github.GitHubDeviceAuthRequestSchema), options),
        );
      case "disconnect":
        return encode(
          github.GitHubAccountResponseSchema,
          await api.disconnectGitHubAccount(await readMessage(request, github.GitHubAccountRequestSchema), options),
        );
      case "pat":
        return encode(
          github.GitHubAccountResponseSchema,
          await api.useGitHubPat(await readMessage(request, github.UseGitHubPatRequestSchema), options),
        );
      case "installations":
        return encode(
          github.GitHubInstallationsResponseSchema,
          await api.listGitHubInstallations(await readMessage(request, github.GitHubCatalogueRequestSchema), options),
        );
      case "repositories":
        return encode(
          github.GitHubRepositoriesResponseSchema,
          await api.listGitHubRepositories(await readMessage(request, github.GitHubCatalogueRequestSchema), options),
        );
      default:
        error(404, "GitHub operation not found");
    }
  });

  return json(result, { headers: { "Cache-Control": "no-store" } });
};
