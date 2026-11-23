import { Predicate, Schema } from "effect";
import { createConnection, type Socket } from "node:net";
import { ConnectorFailure } from "./records.ts";

export type Address = { address: string; family: number };

const connectCode = Schema.Literals(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "ETIMEDOUT"]);
const isConnectCode = Schema.is(connectCode);

type ConnectCode = typeof connectCode.Type;

export class OAuthNetworkFailure extends ConnectorFailure {
  constructor(readonly code: ConnectCode | "dns" | "timeout" | "transport") {
    super("Could not reach the OAuth server. Check your network connection.");
  }
}

/** Only the TCP dial can produce this failure. No HTTP request has been attached to the socket. */
export class OAuthConnectFailure extends OAuthNetworkFailure {
  constructor(code: ConnectCode) {
    super(code);
  }
}

export function connectPinned(address: Address, port: number, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const socket = createConnection({ host: address.address, family: address.family, port, signal });

    const timer = setTimeout(() => {
      socket.destroy(new OAuthConnectFailure("ETIMEDOUT"));
    }, 2_000);

    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      const code = Predicate.hasProperty(error, "code") ? error.code : undefined;

      if (isConnectCode(code)) reject(new OAuthConnectFailure(code));
      else reject(error);
    };

    const onConnect = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(socket);
    };

    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}
