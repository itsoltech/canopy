import { Effect } from "effect";
import type { GitHubAccounts } from "./service.ts";
import type { AccountRow } from "./records.ts";
import { updateAccount } from "./update-account.ts";

const fixedRelease = (url: URL) =>
  url.origin === "https://api.github.com" &&
  !url.username &&
  !url.password &&
  !url.hash &&
  ((url.pathname === "/repos/itsoltech/canopy/releases" && /^\?per_page=100&page=[1-9][0-9]{0,2}$/.test(url.search)) ||
    (/^\/repos\/itsoltech\/canopy\/releases\/tags\/[a-zA-Z0-9_.%-]+$/.test(url.pathname) && !url.search));

interface Context {
  row?: AccountRow | undefined;
  signal: AbortSignal;
  key: string;
}

/** CDN first is owned by ReleaseCatalog. Only the original fixed API lookup can use a gateway credential. */
export function githubReleaseFetch(
  accounts: GitHubAccounts,
  admin: () => Promise<boolean>,
  publicFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
) {
  const contexts = new Map<string, Context>();

  const cacheScope = async (url: string) => {
    if (!fixedRelease(new URL(url))) return "public";
    const signal = AbortSignal.timeout(2000);
    let row: AccountRow | undefined;

    try {
      row = await Promise.race([
        candidate(accounts, admin),
        new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
      ]);
    } catch {
      /* An account is never required to check for releases. */
    }

    const key = row ? `${accounts.owner}:${row.id}:${row.revision}` : "public";

    if (contexts.size >= 8) contexts.delete(contexts.keys().next().value!);
    contexts.set(url, { row, key, signal });

    return key;
  };

  const wrapped = async (input: string | URL | Request, init?: RequestInit, redirected = false) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const context = contexts.get(url.href);
    contexts.delete(url.href);

    if (!redirected && fixedRelease(url) && context?.row && !context.signal.aborted) {
      try {
        const response = await Promise.race([
          authenticated(accounts, context.row, url, context.signal),
          new Promise<undefined>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
          ),
        ]);

        if (response) return response;
      } catch {
        /* Existing public cooldown/cache is the recovery path. */
      }
    }

    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("cookie");

    return publicFetch(input, { ...init, headers, credentials: "omit" });
  };

  return Object.assign(wrapped, { cacheScope });
}

async function candidate(accounts: GitHubAccounts, admin: () => Promise<boolean>) {
  if (!(await admin())) return;
  const setting = await updateAccount(accounts);

  if (!setting.enabled || !setting.accountId) return;
  const row = await accounts.run((s) => s.owned(accounts.owner, setting.accountId));

  if (row.status !== "connected" || row.refresh_lease) return;

  if (row.auth_kind === "device") {
    const pair = await accounts.run((s) => Effect.sync(() => s.open(row)));

    if (pair.expiresAt <= accounts.http.now() + 300_000) return;
  }

  return row;
}

async function authenticated(accounts: GitHubAccounts, row: AccountRow, url: URL, signal: AbortSignal) {
  signal.throwIfAborted();
  const setting = await updateAccount(accounts);
  const current = await accounts.run((s) => s.owned(accounts.owner, row.id));

  if (
    !setting.enabled ||
    setting.accountId !== row.id ||
    current.revision !== row.revision ||
    current.status !== "connected"
  )
    return;

  const result = await accounts.prs.client.read(row.id, {
    key: `release:${url.pathname}${url.search}`,
    path: `${url.pathname}${url.search}`,
    ttl: 900_000,
    signal,
  });

  return new Response(JSON.stringify(result.payload?.["items"] ?? result.payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
