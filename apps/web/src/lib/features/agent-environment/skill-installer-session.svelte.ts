import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  SkillInstallerRequestSchema,
  SkillInstallerResultSchema,
  ui,
  type SkillArtifact,
  type SkillInstallerResult,
} from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

const endpoint = "/api/agent-environment/skills/installer";
const inputChunkBytes = 4 * 1024;
const maxQueuedBytes = 32 * 1024;
const encoder = new TextEncoder();

type InstallerAction = MessageInitShape<typeof SkillInstallerRequestSchema>;

type TerminalSize = { cols: number; rows: number };

type InstallerTerminal = {
  size(): TerminalSize;
  write(output: Uint8Array): Promise<void>;
  clear(): void;
};

export class SkillInstallerSession {
  phase = $state<"starting" | "running" | "stopping" | "draining" | "finished" | "failed">("starting");
  error = $state("");
  outputTruncated = $state(false);
  paths = $state.raw<string[]>([]);
  exitCode = $state<number>();
  succeeded = $state(false);
  stopped = $state(false);
  collecting = $state(false);
  active = $derived(
    this.phase === "starting" || this.phase === "running" || this.phase === "stopping" || this.phase === "draining",
  );

  #id = crypto.randomUUID();
  #startRequest?: Promise<SkillInstallerResult>;
  #terminal?: InstallerTerminal;
  #pollTimer?: ReturnType<typeof setTimeout>;
  #closed = false;
  #offset = 0n;
  #readFailures = 0;
  #input: Uint8Array[] = [];
  #queuedBytes = 0;
  #writing = false;
  #stopRequested = false;

  constructor(readonly workerId: string) {
    window.addEventListener("pagehide", this.#leave);
  }

  async start(command: string, terminal: InstallerTerminal) {
    if (this.#closed || this.#startRequest || this.phase !== "starting") return;
    this.#terminal = terminal;
    this.#startRequest = this.#request({ action: "start", command, ...terminal.size() });

    try {
      const result = await this.#startRequest;

      if (!this.#closed) await this.#receive(result);
    } catch {
      this.#fail("Couldn't start the installer. Check the computer connection and try again.");
    }
  }

  terminalUnavailable() {
    if (!this.#closed) {
      this.error = "Couldn't open the terminal. Run the command in your own terminal or try again.";
      this.phase = "failed";
    }
  }

  send(data: string, binary = false) {
    if (this.#closed || this.phase !== "running") return;
    const bytes = binary ? Uint8Array.from(data, (character) => character.charCodeAt(0)) : encoder.encode(data);

    if (this.#queuedBytes + bytes.length > maxQueuedBytes) {
      this.error = "Terminal input is full. Wait a moment, then enter less text.";

      return;
    }

    for (let index = 0; index < bytes.length; index += inputChunkBytes)
      this.#input.push(bytes.subarray(index, index + inputChunkBytes));

    this.#queuedBytes += bytes.length;
    void this.#write();
  }

  async stop() {
    if (this.#closed || (this.phase !== "starting" && this.phase !== "running")) return;

    if (!this.#startRequest) {
      this.stopped = true;
      this.phase = "finished";

      return;
    }

    this.phase = "stopping";
    this.#stopRequested = true;
    this.error = "";
    this.#clearInput();

    try {
      await this.#startRequest;

      if (this.#closed || this.phase !== "stopping") return;

      await this.#request({ action: "cancel" });
    } catch {
      if (this.#closed || this.phase !== "stopping") return;
      this.#stopRequested = false;
      this.error = "Couldn't stop the installer. Try again or close the editor.";
      this.phase = "running";
    }
  }

  async collect(skillPath: string): Promise<SkillArtifact | undefined> {
    if (this.#closed || this.collecting || !this.paths.includes(skillPath)) return;
    this.collecting = true;
    this.error = "";

    try {
      const { artifact } = await this.#request({ action: "collect", skillPath });

      if (this.#closed) return;

      if (!artifact?.files.length) throw new Error("No skill files");

      return artifact;
    } catch {
      if (!this.#closed) this.error = "Couldn't collect this skill. Try again or upload its folder.";
    } finally {
      if (!this.#closed) this.collecting = false;
    }
  }

  dispose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#terminal = undefined;
    clearTimeout(this.#pollTimer);
    this.#clearInput();
    window.removeEventListener("pagehide", this.#leave);
    void this.#closeAfterStart();
  }

  async #closeAfterStart() {
    if (!this.#startRequest) return;

    await this.#startRequest.catch(() => undefined);
    this.#sendClose();
  }

  #leave = () => {
    if (this.#startRequest) this.#sendClose();
    this.#terminal?.clear();
    this.dispose();
    this.phase = "failed";
    this.succeeded = false;
    this.paths = [];
    this.error = "The terminal closed. Run the installer again or upload its folder.";
  };

  #sendClose() {
    void fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.#body({ action: "close" })),
      keepalive: true,
    }).catch(() => undefined);
  }

  #body(input: InstallerAction) {
    const installer = create(SkillInstallerRequestSchema, { ...input, sessionId: this.#id });

    return encode(
      ui.RunSkillInstallerRequestSchema,
      create(ui.RunSkillInstallerRequestSchema, { workerId: this.workerId, installer }),
    );
  }

  async #request(input: InstallerAction) {
    const response = await requestJson("POST", endpoint, this.#body(input));
    const result = decode(SkillInstallerResultSchema, response);

    if (result.sessionId !== this.#id) throw new Error("Unexpected installer session");

    return result;
  }

  #scheduleRead(delay: number) {
    this.#pollTimer = setTimeout(() => void this.#read(), delay);
  }

  async #read() {
    if (this.#closed || !this.#terminal) return;

    try {
      const result = await this.#request({ action: "read", offset: this.#offset, ...this.#terminal.size() });

      if (this.#closed) return;
      this.#readFailures = 0;
      await this.#receive(result);
    } catch {
      if (this.#closed) return;
      this.#readFailures++;

      if (this.#readFailures < 3) this.#scheduleRead(1000 * this.#readFailures);
      else this.#fail("Lost contact with the installer. Check the computer connection and run it again.");
    }
  }

  async #receive(result: SkillInstallerResult) {
    if (result.offset < this.#offset || (result.output.length && result.offset === this.#offset)) {
      this.#fail("Couldn't read the terminal output. Run the installer again or upload its folder.");

      return;
    }

    this.#offset = result.offset;
    this.outputTruncated ||= result.outputTruncated;

    if (!result.running) {
      this.#clearInput();

      if (!result.output.length) {
        this.exitCode = result.exitCode;
        this.succeeded = result.exitCode === 0 && !result.reason;
        this.paths = this.succeeded ? result.skillPaths : [];
        this.stopped = this.#stopRequested && !this.succeeded;
        this.phase = "finished";

        if ((result.exitCode === undefined || result.exitCode === 0) && !this.succeeded && !this.stopped)
          this.error = "The installer ended unexpectedly. Run it again or upload its folder.";

        return;
      }

      this.phase = "draining";
    } else if (this.phase === "starting") this.phase = "running";

    if (result.output.length) await this.#terminal?.write(result.output);

    if (!this.#closed) this.#scheduleRead(result.output.length ? 75 : 300);
  }

  async #write() {
    if (this.#writing) return;
    this.#writing = true;

    try {
      while (!this.#closed && this.phase === "running") {
        const input = this.#input.shift();

        if (!input) break;
        this.#queuedBytes -= input.length;
        await this.#request({ action: "write", input });
      }
    } catch {
      this.#clearInput();

      if (!this.#closed && this.phase === "running")
        this.error = "Couldn't confirm terminal input. Check the prompt before typing again.";
    } finally {
      this.#writing = false;
    }
  }

  #clearInput() {
    this.#input = [];
    this.#queuedBytes = 0;
  }

  #fail(message: string) {
    if (this.#closed) return;
    this.dispose();
    this.phase = "failed";
    this.error = message;
  }
}
