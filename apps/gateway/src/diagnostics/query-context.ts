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

/** Label a shared store boundary, including nested SQL helpers and transaction controls.
 * Inner call-site labels take precedence; synchronous mappers keep their original result.
 */
export function queryMethods<
  Methods extends { [Key in keyof Methods]: (...args: never[]) => object | string | number | boolean | void | null },
>(family: DatabaseFamily, methods: Methods): Methods {
  const labelled = Object.fromEntries(
    Object.keys(methods).map((name) => [
      name,
      (...args: never[]) => {
        // SAFETY: Object.keys enumerates this store's own method names.
        const method = methods[name as keyof Methods];
        const result = method(...args);

        return Effect.isEffect(result) ? result.pipe(queryFamily(family)) : result;
      },
    ]),
  );

  // SAFETY: every original key and call signature is preserved; only Effect context is provided.
  return labelled as Methods;
}

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
