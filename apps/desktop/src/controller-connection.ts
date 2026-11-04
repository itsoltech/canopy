import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { DesktopStatus } from "@canopy/ui/desktop";
import type { ControllerArguments, ControllerResponse, ControllerResult } from "./controller.ts";
import type { Logs } from "./runtime/log.ts";

export class ControllerConnection {
  private sequence = 0;
  private readonly requests = new Map<
    number,
    { resolve: (value: ControllerResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly controller: ChildProcessWithoutNullStreams,
    logs: Logs,
    changed: (status: DesktopStatus) => void,
    exited: () => void,
    remoteUpdate: (command: string) => void = () => {},
  ) {
    controller.stderr.on("data", logs.stream("controller"));
    createInterface({ input: controller.stdout }).on("line", (line) => {
      try {
        // SAFETY: stdout is the private protocol pipe of our spawned, bundled controller; send uses ControllerResponse.
        const message = JSON.parse(line) as ControllerResponse;

        if (message.event === "remote-update" && message.command) {
          remoteUpdate(message.command);

          return;
        }

        if (message.event === "status" && message.status) {
          changed(message.status);

          return;
        }

        if (message.id) {
          const request = this.requests.get(message.id);

          if (!request) return;
          this.requests.delete(message.id);
          clearTimeout(request.timer);

          if (message.error) request.reject(new Error(message.error));
          else request.resolve(message.result ?? {});
        }
      } catch {
        logs.write("controller", "Invalid controller message");
      }
    });
    controller.on("error", (error) => logs.write("controller", error.message));
    controller.once("exit", () => {
      for (const request of this.requests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Desktop services stopped"));
      }

      this.requests.clear();
      exited();
    });
  }

  request(action: string, args: ControllerArguments = {}) {
    return new Promise<ControllerResult>((resolveRequest, reject) => {
      if (!this.controller.stdin.writable) {
        reject(new Error("Desktop services are unavailable; restart Canopy"));

        return;
      }

      const id = ++this.sequence;

      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error("Desktop operation timed out; see logs"));
      }, 20 * 60_000);

      this.requests.set(id, { resolve: resolveRequest, reject, timer });
      this.controller.stdin.write(JSON.stringify({ id, action, ...args }) + "\n");
    });
  }
}
