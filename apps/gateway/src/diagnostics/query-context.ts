import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Effect } from "effect";
import type { DatabaseFamily } from "@canopy/domain/diagnostics";

export const rpcContext = new AsyncLocalStorage<number>();
export const QueryRpc = Context.Reference<number>("canopy/diagnostics/QueryRpc", { defaultValue: () => 0 });

export const QueryFamily = Context.Reference<DatabaseFamily>("canopy/diagnostics/QueryFamily", {
  defaultValue: () => "other",
});

/** Store code assigns an allowlisted label. SQL and parameters never enter this context. */
export const queryFamily = (family: DatabaseFamily) => Effect.provideService(QueryFamily, family);

export const queryRpc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, QueryRpc, rpcContext.getStore() ?? 0);

export async function* rpcMessages<A>(source: AsyncIterable<A>, id: number) {
  const iterator = source[Symbol.asyncIterator]();

  try {
    for (;;) {
      const next = await rpcContext.run(id, () => iterator.next());

      if (next.done) return;
      yield next.value;
    }
  } finally {
    await rpcContext.run(id, () => iterator.return?.());
  }
}
