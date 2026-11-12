import type { Mention, ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { checkedQuotes } from "../core/quotes.ts";
import { Invalid } from "../store/store.ts";

/** A source reference must belong to this owner, just as the destination does. */
export function botQuotes(
  sql: SqlClient.SqlClient,
  user: string,
  quotes: readonly ui.Quote[],
  text: string,
  mentions: readonly Mention[] = [],
) {
  return Effect.gen(function* () {
    const checked = yield* Effect.try({
      try: () => checkedQuotes(quotes, (message) => new Invalid(message), text, mentions),
      catch: (cause) => (cause instanceof Invalid ? cause : new Invalid("Invalid citations")),
    });

    for (const quote of checked) {
      if (!quote.sourceThreadId) continue;

      const owned =
        yield* sql`SELECT id FROM bots WHERE id::text=${quote.sourceThreadId} AND owner_user_id=${user}::uuid
        UNION ALL SELECT id FROM threads WHERE id::text=${quote.sourceThreadId} AND owner_user_id=${user}::uuid`;

      if (!owned.length) return yield* Effect.fail(new Invalid("citation source not found"));
    }

    return checked;
  });
}
