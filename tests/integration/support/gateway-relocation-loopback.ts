import { Server } from "node:net";

// Loaded in the real gateway subprocess. Its Network access listener normally binds every interface.
Server.prototype.listen = new Proxy(Server.prototype.listen, {
  apply(listen, server, args) {
    if (String(args[0]) === process.env["CANOPY_NETWORK_PORT"] && (args[1] === "::" || args[1] === "0.0.0.0"))
      args[1] = "127.0.0.1";

    return Function.prototype.apply.call(listen, server, args);
  },
});

// The update and provider version checks cannot use the network during this test.
const fetchLocal = globalThis.fetch;

Object.assign(globalThis, {
  fetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const url = new URL(input instanceof Request ? input.url : input);

    if (url.hostname !== "127.0.0.1") return Promise.reject(new Error("Relocation fixtures use loopback only"));

    return fetchLocal(input, { ...init, redirect: "error" });
  },
});
