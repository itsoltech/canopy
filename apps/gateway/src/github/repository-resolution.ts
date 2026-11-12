import { Code, ConnectError } from "@connectrpc/connect";
import type { GitHubAccounts } from "./service.ts";

/** Refreshes only expired catalogues; the catalogue client deduplicates concurrent refreshes. */
export async function refreshRepositoryAccounts(accounts: GitHubAccounts) {
  await accounts.pat.invalidate();
  const rows = await accounts.run((s) => s.connectedGitHubAccounts(accounts.owner));
  const results = await Promise.allSettled(rows.map((row) => accounts.catalogue.refresh(row.id)));

  return {
    verified: new Set(rows.filter((_row, index) => results[index]?.status === "fulfilled").map((row) => row.id)),
    failure: results.find((result) => result.status === "rejected"),
  };
}

/** The indexed intersection belongs to this owner. Remembered choices win while access remains valid. */
export async function resolveRepository(
  accounts: GitHubAccounts,
  name: string,
  changed: (repo?: string) => Promise<void>,
  cachedOnly = false,
) {
  const { run, owner } = accounts;

  const { verified, failure } = cachedOnly
    ? {
        verified: new Set(
          (await run((s) => s.connectedGitHubAccounts(owner)))
            .filter(
              (row) =>
                row.auth_kind === "pat" ||
                (row.catalog_verified_at && Number(new Date(row.catalog_verified_at)) > accounts.http.now() - 900_000),
            )
            .map((row) => row.id),
        ),
        failure: undefined,
      }
    : await refreshRepositoryAccounts(accounts);

  const candidates = (await run((s) => s.repositoryAccess(owner, name)))
    .filter((row) => verified.has(row.id))
    .sort(
      (a, b) =>
        Number(b.account_type === "User") - Number(a.account_type === "User") ||
        a.login.toLowerCase().localeCompare(b.login.toLowerCase()) ||
        a.id.localeCompare(b.id),
    );

  if (!candidates.length && failure?.status === "rejected") throw failure.reason;

  for (let attempt = 0; attempt < 2; attempt++) {
    const mapping = (await run((s) => s.repositoryAccount(owner, name)))[0];

    if (
      mapping &&
      candidates.some((row) => row.id === mapping.account_id && row.repository_id === mapping.repository_id)
    )
      return { mapping, candidates };
    const chosen = candidates[0];

    if (!chosen) return { mapping: undefined, candidates };

    try {
      const saved = await run((s) =>
        s.repositoryChoose(chosen, chosen.repository_id, chosen.repository_name, BigInt(mapping?.revision ?? 0)),
      );

      await run((s) => s.audit(owner, "repository_account", chosen.id));
      await changed(chosen.repository_id);

      return { mapping: saved, candidates };
    } catch (cause) {
      if (!(cause instanceof ConnectError && cause.code === Code.Aborted) || attempt > 0) throw cause;
    }
  }

  throw new ConnectError("Repository access changed. Retry the request.", Code.Aborted);
}
