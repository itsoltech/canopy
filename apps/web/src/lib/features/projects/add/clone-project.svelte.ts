import { ui, type CloneProgress } from "@canopy/contracts";
import { CLONE_RPC_TIMEOUT_MS } from "@canopy/domain/clone-progress";
import { isJsonObject, parseJson, str } from "#lib/shared/json.ts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

export class CloneProjectState {
  progress = $state.raw<CloneProgress>();
  attempted = $state(false);
  cancelled = $state(false);
  #abort: AbortController | undefined;

  reset(): void {
    this.progress = undefined;
    this.attempted = false;
    this.cancelled = false;
  }

  cancel(): void {
    this.cancelled = true;
    this.#abort?.abort();
  }

  async run(input: ui.AddProjectRequest, capable: boolean): Promise<ui.AddProjectResponse> {
    this.reset();
    this.attempted = true;

    if (!capable)
      return decode(
        ui.AddProjectResponseSchema,
        await requestJson("POST", "/api/projects", encode(ui.AddProjectRequestSchema, input), CLONE_RPC_TIMEOUT_MS),
      );
    const controller = new AbortController();
    this.#abort = controller;

    try {
      return await this.#stream(input, controller.signal);
    } finally {
      this.#abort = undefined;
    }
  }

  async #stream(input: ui.AddProjectRequest, signal: AbortSignal): Promise<ui.AddProjectResponse> {
    const response = await fetch("/api/projects/clone", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(encode(ui.AddProjectRequestSchema, input)),
    });

    if (!response.ok || !response.body) throw new Error("Could not start cloning. Check the connection and retry.");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let result: ui.AddProjectResponse | undefined;

    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line) continue;
          const message = parseJson(line);

          if (!isJsonObject(message)) throw new Error("Cloning was interrupted. Check the connection and retry.");
          const error = str(message["error"]);

          if (error) throw new Error(error);

          if (message["event"]) {
            const event = decode(ui.CloneProjectUpdateSchema, message["event"]);

            if (event.progress) this.progress = event.progress;

            if (event.result) result = event.result;
          }
        }
      }

      if (!result) throw new Error("Cloning was interrupted. Check the connection and retry.");

      return result;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
