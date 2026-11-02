import { AsyncLocalStorage } from "node:async_hooks";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { BotStore } from "../bots/store.ts";
import type { BotTurn, StoredCall } from "../bots/types.ts";
import type { CoreRuntime, CoreServices } from "./core.ts";

interface Scope {
  run: <A, E>(effect: Effect.Effect<A, E, CoreServices>) => Promise<A>;
  after: (() => void | Promise<void>)[];
}

/** Preserve the SQL transaction across the UI core's async methods. Nothing leaves
 * the gateway until both the mutation and the tool result have committed. */
export class ActionContext {
  readonly #scope = new AsyncLocalStorage<Scope>();
  constructor(readonly runtime: CoreRuntime) {}

  run<A, E>(effect: Effect.Effect<A, E, CoreServices>): Promise<A> {
    return this.#scope.getStore()?.run(effect) ?? this.runtime.runPromise(effect);
  }

  defer(action: () => void | Promise<void>): boolean {
    const scope = this.#scope.getStore();
    if (!scope) return false;
    scope.after.push(action);
    return true;
  }

  async action<A>(turn: BotTurn, call: StoredCall, perform: () => Promise<A>): Promise<A> {
    const after: Scope["after"] = [];
    const scope = this.#scope;
    const result = await this.runtime.runPromise(BotStore.use((bots) => bots.action(turn, call, Effect.gen(function* () {
      // SqlClient's transaction connection lives in the Effect context too.
      const context = yield* Effect.context<CoreServices>();
      return yield* Effect.tryPromise({
        try: () => scope.run({ run: Effect.runPromiseWith(context), after }, perform),
        catch: (error) => error,
      });
    }))));
    // A failure here cannot undo the durable result. Worker commands remain in
    // the existing outbox and recover on reconnect; inference reads the result.
    for (const notify of after) await notify();
    return result;
  }

  async transaction<A>(perform: () => Promise<A>): Promise<A> {
    if (this.#scope.getStore()) return perform();
    const after: Scope["after"] = [];
    const scope = this.#scope;
    const result = await this.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(Effect.gen(function* () {
        const context = yield* Effect.context<CoreServices>();
        return yield* Effect.tryPromise({ try: () => scope.run({ run: Effect.runPromiseWith(context), after }, perform), catch: (error) => error });
      }));
    }));
    for (const notify of after) await notify();
    return result;
  }
}
