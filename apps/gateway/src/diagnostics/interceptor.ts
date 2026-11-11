import type { Message } from "@bufbuild/protobuf";
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import type { RpcCollector, RpcObservation } from "./collector.ts";
import { registered } from "./registry.ts";
import { messageKind } from "./message-kind.ts";
import { rpcContext, rpcMessages } from "./query-context.ts";

async function* messages(
  input: AsyncIterable<Message>,
  observation: RpcObservation,
  direction: "request" | "response",
) {
  for await (const message of input) {
    observation.message(direction, undefined, messageKind(message));
    yield message;
  }
}

/** Abort releases gauges even if a generator is waiting forever and never receives return(). */
export function diagnosticsInterceptor(collector: RpcCollector): Interceptor {
  return (next) => async (request) => {
    const id = registered(request.method).id;
    const observation = collector.start(id);

    if (!observation) return next(request);
    const abort = () => observation.finish(Code.Canceled);

    const release = (code = 0) => {
      request.signal.removeEventListener("abort", abort);
      observation.finish(code);
    };

    request.signal.addEventListener("abort", abort, { once: true });

    if (request.signal.aborted) abort();

    try {
      if (!request.stream) observation.message("request");

      const response = await rpcContext.run(id, () =>
        next(request.stream ? { ...request, message: messages(request.message, observation, "request") } : request),
      );

      if (!response.stream) {
        observation.message("response");
        release();

        return response;
      }

      return {
        ...response,
        message: (async function* () {
          try {
            yield* messages(rpcMessages(response.message, id), observation, "response");
          } catch (error) {
            release(ConnectError.from(error).code);
            throw error;
          } finally {
            release(request.signal.aborted ? Code.Canceled : 0);
          }
        })(),
      };
    } catch (error) {
      release(ConnectError.from(error).code);
      throw error;
    }
  };
}
