import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { questionStore, type QuestionStore } from "./questions.ts";
import { busCallStore, type BusCallStore } from "./bus-calls.ts";
import { busThreadStore, type BusThreadStore } from "./bus-threads.ts";
import { busScheduleStore, type BusScheduleStore } from "./bus-schedules.ts";
import { busDeliveryStore, type BusDeliveryStore } from "./bus-deliveries.ts";
import { queryMethods } from "../diagnostics/query-context.ts";

/**
 * Agent bus persistence (docs/agent-bus.md): the facts `authorizeBusCall` decides on, and the writes of
 * the calls it allows. Every call is idempotent by its id (= AgentToolCall.call_id): a call re-sent
 * after a reconnect finds its stored result instead of running again.
 */

export {
  busPermissionMode,
  inputJson,
  isUniqueViolation,
  ScheduleConflict,
  toUiDelivery,
  toUiSchedule,
  truncate,
  type BusCallRow,
  type CallSource,
  type DeliveryRow,
  type FiredSchedule,
  type ForwardedInteraction,
  type NewSchedule,
  type Notification,
  type ScheduleRow,
  type ThreadSummary,
  type TurnInput,
} from "./agent-bus-types.ts";

export class AgentBusStore extends Context.Service<
  AgentBusStore,
  BusCallStore & BusThreadStore & BusScheduleStore & BusDeliveryStore & QuestionStore
>()("canopy/gateway/AgentBusStore") {
  static readonly layer = Layer.effect(
    AgentBusStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return AgentBusStore.of({
        ...queryMethods("interactions.store", questionStore(sql)),
        ...queryMethods("agents.store", busCallStore(sql)),
        ...queryMethods("agents.store", busThreadStore(sql)),
        ...queryMethods("agents.store", busScheduleStore(sql)),
        ...queryMethods("agents.store", busDeliveryStore(sql)),
      });
    }),
  );
}
