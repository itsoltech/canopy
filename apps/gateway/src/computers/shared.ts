import { clone, create, fromJson, toJson, type DescMethod, type JsonValue, type Message } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { computerLink as link, ProviderProfileKind, ui } from "@canopy/contracts";
import { parseSharedKey, type SharedKey } from "@canopy/domain/computers";
import { createHash, randomBytes } from "node:crypto";
import { canonicalJson, isRef, providerOf, type InstanceRow, type StoredEnvVar } from "../store/instance-config.ts";
import { decryptSecret, encryptSecret } from "../store/secrets.ts";
import { methodNamed, type RemoteServe } from "./remote.ts";
import type { ComputerStore } from "./store.ts";

/**
 * Stage 4 of docs/linked-computers.md: configuration the user marked "Share with linked computers".
 * Values live in their own tables (provider_instances, user_settings, projects); this keeps the sharing
 * state, a version vector per item and what every linked computer confirmed. A computer pushes the items
 * a peer does not have yet; the peer applies them with its own handlers, or records a conflict when both
 * changed the same item without seeing each other's change. Secret values cross the link only for shared
 * items and only when the peer lacks them, and are stored again with the receiver's key.
 */

type Clock = Record<string, number>;

type Row = {
  item_key: string;
  shared: boolean;
  clock: Clock;
  digest: string;
  changed_by: string;
  changed_at: Date;
  tokens: Record<string, string>;
  note: string;
};

type Payload = Record<string, JsonValue>;

/** A local value: canonical payload, secret tokens by local secret id, and the reverse. */
type Value = { payload: Payload; tokens: Record<string, string>; refs: Map<string, string>; empty: boolean };

type ConflictRow = {
  item_key: string;
  node_id: string;
  local_payload: Payload | null;
  remote_payload: Payload;
  remote_secrets: Uint8Array | null;
  remote_clock: Clock;
  remote_digest: string;
  remote_changed_at: Date;
  detected_at: Date;
};

type Outcome = {
  outcome: "applied" | "same" | "newer" | "conflict" | "unshared" | "rejected" | "secrets";
  message?: string;
};

/** What the link runtime provides: this computer's own handlers and the connected peers. */
export type SharedHost = {
  /** This computer's GatewayService handlers: validation, worker configuration and live UI updates. */
  serve: RemoteServe;
  /** A project with the shared id (projects are one identity on every computer). */
  createProject(id: string, name: string): Promise<void>;
  /** Badges and conflicts changed (OverviewUpdate.shared_config). */
  publish(snapshot: ui.SharedConfigSnapshot): void;
};

type Peers = {
  self(): string;
  /** Peers connected now with the capability on both sides. */
  ready(): string[];
  /** Linked computers without the capability (older Canopy). */
  outdated(): Promise<string[]>;
  call(nodeId: string, method: DescMethod, request: Message, signal: AbortSignal): AsyncIterable<Message>;
};

const PUSH_TIMEOUT_MS = 15_000;
const ORDER: Record<string, number> = { instance: 0, models: 1, settings: 2, project: 3 };

const SETTINGS_LABEL: Record<string, string> = {
  appearance: "Appearance",
  thread_defaults: "Thread defaults",
  timezone: "Time zone",
  text_generation: "Text generation",
};

const HARNESS_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };

const digestOf = (payload: Payload) => createHash("sha256").update(canonicalJson(payload)).digest("hex");

const merge = (a: Clock, b: Clock): Clock => {
  const out = { ...a };

  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);

  return out;
};

const bump = (clock: Clock, node: string): Clock => ({ ...clock, [node]: (clock[node] ?? 0) + 1 });

function compare(a: Clock, b: Clock): "equal" | "before" | "after" | "concurrent" {
  let less = false;
  let more = false;

  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[k] ?? 0) < (b[k] ?? 0)) less = true;

    if ((a[k] ?? 0) > (b[k] ?? 0)) more = true;
  }

  return less && more ? "concurrent" : less ? "before" : more ? "after" : "equal";
}

const wireClock = (clock: Clock) => Object.fromEntries(Object.entries(clock).map(([k, v]) => [k, BigInt(v)]));

const fromWire = (clock: Record<string, bigint>): Clock =>
  Object.fromEntries(Object.entries(clock).map(([k, v]) => [k, Number(v)]));

const failure = (error: unknown): Outcome => ({
  outcome: "rejected",
  message: error instanceof ConnectError ? error.rawMessage : "could not apply it here",
});

/** Secret tokens a payload refers to. */
function tokensIn(payload: Payload): string[] {
  const env = Array.isArray(payload["env"]) ? (payload["env"] as { token?: string }[]) : [];

  return [
    ...(typeof payload["apiKey"] === "string" ? [payload["apiKey"]] : []),
    ...env.flatMap((v) => (v.token ? [v.token] : [])),
  ];
}

export class SharedConfig {
  #rows = new Map<string, Row>();
  #queue: Promise<unknown> = Promise.resolve();
  #pushing = new Set<string>();
  #again = new Set<string>();
  #publishTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ids of projects shared with linked computers: the same id on every computer. */
  readonly projects = new Set<string>();
  constructor(
    readonly store: ComputerStore,
    readonly host: SharedHost,
    readonly peers: Peers,
  ) {}

  /** One change of sharing state at a time; never held across a call to another computer. */
  #exclusive<A>(run: () => Promise<A>): Promise<A> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});

    return next;
  }
  async load() {
    const rows = await this.store.query<Row>("SELECT * FROM computer_shared_items WHERE owner_user_id=$1::uuid", [
      this.store.owner,
    ]);

    this.#rows = new Map(rows.map((r) => [r.item_key, r]));
    this.projects.clear();

    for (const r of rows) {
      const key = parseSharedKey(r.item_key);

      if (r.shared && key?.kind === "project") this.projects.add(key.id);
    }
  }
  async #save(row: Row) {
    await this.store.query(
      `INSERT INTO computer_shared_items(owner_user_id,item_key,shared,clock,digest,changed_by,changed_at,tokens,note)
      VALUES($1::uuid,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(owner_user_id,item_key) DO UPDATE SET shared=excluded.shared,clock=excluded.clock,
      digest=excluded.digest,changed_by=excluded.changed_by,changed_at=excluded.changed_at,tokens=excluded.tokens,note=excluded.note`,
      [
        this.store.owner,
        row.item_key,
        row.shared,
        JSON.stringify(row.clock),
        row.digest,
        row.changed_by,
        row.changed_at,
        JSON.stringify(row.tokens),
        row.note,
      ],
    );
    this.#rows.set(row.item_key, row);
    const key = parseSharedKey(row.item_key);

    if (key?.kind === "project") {
      if (row.shared) this.projects.add(key.id);
      else this.projects.delete(key.id);
    }
  }
  #row(key: string): Row {
    return (
      this.#rows.get(key) ?? {
        item_key: key,
        shared: false,
        clock: {},
        digest: "",
        changed_by: "",
        changed_at: new Date(),
        tokens: {},
        note: "",
      }
    );
  }
  async #ack(node: string, key: string, digest: string | undefined, shared = true) {
    if (digest === undefined)
      await this.store.query(
        "DELETE FROM computer_shared_acks WHERE owner_user_id=$1::uuid AND node_id=$2 AND item_key=$3",
        [this.store.owner, node, key],
      );
    else
      await this.store.query(
        `INSERT INTO computer_shared_acks(owner_user_id,node_id,item_key,digest,shared) SELECT $1::uuid,$2,$3,$4,$5
      WHERE EXISTS(SELECT 1 FROM computer_peers WHERE owner_user_id=$1::uuid AND node_id=$2)
      ON CONFLICT(owner_user_id,node_id,item_key) DO UPDATE SET digest=excluded.digest,shared=excluded.shared`,
        [this.store.owner, node, key, digest, shared],
      );
  }
  async #local<A extends Message>(name: string, request: Message): Promise<A> {
    const method = methodNamed(name)!;
    const abort = new AbortController();

    try {
      for await (const value of this.host.serve(method, request, abort.signal)) return value as A;
    } finally {
      abort.abort();
    }

    throw new ConnectError("No answer", Code.Internal);
  }

  // ------------------------------------------------------------------ local values

  /** The shared fields of an item on this computer; undefined when it does not exist here. */
  async read(key: SharedKey, tokens: Record<string, string> = {}): Promise<Value | undefined> {
    const value = (payload: Payload, next: Record<string, string> = {}, empty = false): Value => ({
      payload,
      tokens: next,
      refs: new Map(Object.entries(next).map(([ref, token]) => [token, ref])),
      empty,
    });

    if (key.kind === "instance" || key.kind === "models") {
      const row = (
        await this.store.query<InstanceRow>("SELECT * FROM provider_instances WHERE harness=$1 AND id=$2", [
          key.harness,
          key.id,
        ])
      )[0];

      if (!row) return undefined;

      if (key.kind === "models")
        return value(
          { favorites: row.favorites, hidden: row.hidden_models, shown: row.shown_models, custom: row.custom_models },
          {},
          ![row.favorites, row.hidden_models, row.shown_models, row.custom_models].some((l) => l.length),
        );

      // CLI paths, launch arguments, logins and the workers it runs on stay on each computer.
      if (row.built_in) return undefined;
      const next: Record<string, string> = {};
      const token = (ref: string) => (next[ref] = tokens[ref] ?? randomBytes(16).toString("hex"));

      return value(
        {
          label: row.label,
          kind: row.kind,
          baseUrl: row.base_url,
          accentColor: row.accent_color,
          apiKey: isRef(row.api_key) ? token(row.api_key.secretRef) : null,
          env: (row.env ?? []).map((v: StoredEnvVar) =>
            v.secret && isRef(v.value)
              ? { name: v.name, secret: true, token: token(v.value.secretRef) }
              : { name: v.name, value: String(v.value) },
          ),
        },
        next,
      );
    }

    if (key.kind === "project") {
      const row = (
        await this.store.query<{ name: string; kind: string; archived_at: Date | null }>(
          "SELECT name,kind,archived_at FROM projects WHERE id=$1::uuid AND owner_user_id=$2::uuid",
          [key.id, this.store.owner],
        )
      )[0];

      return row && row.kind === "project" && !row.archived_at ? value({ name: row.name }) : undefined;
    }

    if (key.kind !== "settings") return undefined;

    const stored =
      (
        await this.store.query<{ settings: Record<string, JsonValue> }>(
          "SELECT settings FROM user_settings WHERE user_id=$1::uuid",
          [this.store.owner],
        )
      )[0]?.settings ?? {};

    const read = <T>(json: JsonValue | undefined, parse: (j: JsonValue) => T) =>
      json === undefined ? undefined : parse(json);

    let payload: Payload;

    if (key.section === "appearance") {
      const a =
        read(stored["appearance"], (j) => fromJson(ui.AppearanceSettingsSchema, j, { ignoreUnknownFields: true })) ??
        create(ui.AppearanceSettingsSchema);

      // Panel and sidebar layout follow each screen; only the look is shared.
      payload = toJson(
        ui.AppearanceSettingsSchema,
        create(ui.AppearanceSettingsSchema, { colorScheme: a.colorScheme, accent: a.accent, chatWidth: a.chatWidth }),
      ) as Payload;
    } else if (key.section === "thread_defaults") {
      const t =
        read(stored["threadDefaults"], (j) => fromJson(ui.ThreadDefaultsSchema, j, { ignoreUnknownFields: true })) ??
        create(ui.ThreadDefaultsSchema);

      // A workspace is a directory on one machine.
      t.workspaceId = "";
      payload = toJson(ui.ThreadDefaultsSchema, t) as Payload;
    } else if (key.section === "timezone")
      payload = typeof stored["timezone"] === "string" && stored["timezone"] ? { timezone: stored["timezone"] } : {};
    else
      payload = toJson(
        ui.TextGenerationSettingsSchema,
        read(stored["textGeneration"], (j) =>
          fromJson(ui.TextGenerationSettingsSchema, j, { ignoreUnknownFields: true }),
        ) ?? create(ui.TextGenerationSettingsSchema),
      ) as Payload;

    return value(payload, {}, !Object.keys(payload).length);
  }

  /** Writes a peer's value through this computer's own handlers. Returns the local secret tokens. */
  async #write(
    key: SharedKey,
    payload: Payload,
    secrets: Map<string, string>,
    current: Value | undefined,
  ): Promise<Outcome & { tokens?: Record<string, string> }> {
    try {
      if (key.kind === "instance") {
        const row = (
          await this.store.query<InstanceRow>("SELECT * FROM provider_instances WHERE harness=$1 AND id=$2", [
            key.harness,
            key.id,
          ])
        )[0];

        if (row?.built_in) return { outcome: "rejected", message: "the built-in login is configured on each computer" };
        const known = current?.payload ?? {};

        const knownEnv = new Map(
          (Array.isArray(known["env"]) ? (known["env"] as { name: string; token?: string }[]) : []).map((v) => [
            v.name,
            v.token,
          ]),
        );

        const missing: string[] = [];

        const secret = (token: string, same: boolean) => {
          if (same) return undefined;
          const value = secrets.get(token);

          if (value === undefined) missing.push(token);

          return value;
        };

        const apiKey =
          payload["apiKey"] === null
            ? row && isRef(row.api_key)
              ? ""
              : undefined
            : secret(String(payload["apiKey"]), known["apiKey"] === payload["apiKey"]);

        const env = (payload["env"] as { name: string; value?: string; secret?: boolean; token?: string }[]).map((v) =>
          v.secret
            ? { name: v.name, secret: true, value: secret(v.token!, knownEnv.get(v.name) === v.token) }
            : { name: v.name, secret: false, value: v.value ?? "" },
        );

        if (missing.length) return { outcome: "secrets" };
        const runtime = row?.runtime ?? {};
        await this.#local(
          "SaveProviderInstance",
          create(ui.SaveProviderInstanceRequestSchema, {
            harness: providerOf(key.harness),
            id: key.id,
            create: !row,
            label: String(payload["label"]),
            kind: payload["kind"] === "endpoint" ? ProviderProfileKind.CLIPROXYAPI : ProviderProfileKind.NATIVE,
            baseUrl: String(payload["baseUrl"] ?? ""),
            ...(apiKey !== undefined && { apiKey }),
            env,
            accentColor: String(payload["accentColor"] ?? ""),
            runtime: {
              binaryPath: runtime.binaryPath ?? "",
              homePath: runtime.homePath ?? "",
              shadowHomePath: runtime.shadowHomePath ?? "",
              launchArgs: runtime.launchArgs ?? [],
              ownLogin: runtime.ownLogin === true,
            },
            // A new shared instance is usable on this computer's workers at once; the choice stays local afterwards.
            allWorkers: true,
          }),
        );

        const saved = (
          await this.store.query<InstanceRow>("SELECT * FROM provider_instances WHERE harness=$1 AND id=$2", [
            key.harness,
            key.id,
          ])
        )[0]!;

        const tokens: Record<string, string> = {};

        if (isRef(saved.api_key) && typeof payload["apiKey"] === "string")
          tokens[saved.api_key.secretRef] = payload["apiKey"];
        const incoming = new Map((payload["env"] as { name: string; token?: string }[]).map((v) => [v.name, v.token]));

        for (const v of saved.env ?? [])
          if (v.secret && isRef(v.value) && incoming.get(v.name)) tokens[v.value.secretRef] = incoming.get(v.name)!;

        return { outcome: "applied", tokens };
      }

      if (key.kind === "models") {
        if (!current) return { outcome: "rejected", message: "the instance is not on this computer" };
        await this.#local(
          "SetInstanceModels",
          create(ui.SetInstanceModelsRequestSchema, {
            harness: providerOf(key.harness),
            id: key.id,
            models: {
              favorites: payload["favorites"] as string[],
              hidden: payload["hidden"] as string[],
              shown: payload["shown"] as string[],
              custom: payload["custom"] as string[],
            },
          }),
        );

        return { outcome: "applied", tokens: {} };
      }

      if (key.kind === "project") {
        const row = (
          await this.store.query<{ name: string; kind: string; archived_at: Date | null }>(
            "SELECT name,kind,archived_at FROM projects WHERE id=$1::uuid AND owner_user_id=$2::uuid",
            [key.id, this.store.owner],
          )
        )[0];

        if (!row) await this.host.createProject(key.id, String(payload["name"]));
        else if (row.kind !== "project" || row.archived_at)
          return { outcome: "rejected", message: "the project is archived on this computer" };
        else if (row.name !== payload["name"])
          await this.#local(
            "RenameProject",
            create(ui.RenameProjectRequestSchema, { projectId: key.id, name: String(payload["name"]) }),
          );

        return { outcome: "applied", tokens: {} };
      }

      if (key.kind !== "settings") return { outcome: "rejected", message: "unknown item" };

      for (let attempt = 0; ; attempt++) {
        const user =
          (await this.#local<ui.GetSettingsResponse>("GetSettings", create(ui.GetSettingsRequestSchema))).user ??
          create(ui.UserSettingsSchema);

        const request = create(ui.UpdateUserSettingsRequestSchema, { expectedVersion: user.version });

        if (key.section === "appearance") {
          const a = fromJson(ui.AppearanceSettingsSchema, payload, { ignoreUnknownFields: true });
          request.appearance = clone(
            ui.AppearanceSettingsSchema,
            user.appearance ?? create(ui.AppearanceSettingsSchema),
          );
          Object.assign(request.appearance, { colorScheme: a.colorScheme, accent: a.accent, chatWidth: a.chatWidth });
        } else if (key.section === "thread_defaults") {
          request.threadDefaults = fromJson(ui.ThreadDefaultsSchema, payload, { ignoreUnknownFields: true });
          request.threadDefaults.workspaceId = user.threadDefaults?.workspaceId ?? "";
        } else if (key.section === "timezone") {
          if (typeof payload["timezone"] !== "string") return { outcome: "same" };
          request.timezone = payload["timezone"];
        } else
          request.textGeneration = fromJson(ui.TextGenerationSettingsSchema, payload, { ignoreUnknownFields: true });

        try {
          await this.#local("UpdateUserSettings", request);

          return { outcome: "applied", tokens: {} };
        } catch (error) {
          if (attempt >= 2 || !(error instanceof ConnectError && error.code === Code.FailedPrecondition)) throw error;
        }
      }
    } catch (error) {
      return failure(error);
    }
  }

  async #secretValues(refs: Map<string, string>): Promise<link.SharedSecret[]> {
    if (!refs.size) return [];

    const rows = await this.store.query<{ id: string; ciphertext: Uint8Array }>(
      "SELECT id::text,ciphertext FROM secrets WHERE id=ANY($1::uuid[])",
      [[...refs.values()]],
    );

    const byRef = new Map(rows.map((r) => [r.id, r.ciphertext]));

    return [...refs].flatMap(([token, ref]) =>
      byRef.has(ref)
        ? [create(link.SharedSecretSchema, { token, value: decryptSecret(this.store.key, byRef.get(ref)!) })]
        : [],
    );
  }

  // ------------------------------------------------------------------ this computer's changes

  /** Notices local edits and deletions of shared items: a new version by this computer. */
  scan(): Promise<boolean> {
    return this.#exclusive(async () => {
      let changed = false;

      for (const row of [...this.#rows.values()].filter((r) => r.shared)) {
        const key = parseSharedKey(row.item_key);

        if (!key) continue;
        const value = await this.read(key, row.tokens);

        if (!value) {
          // Deleted or archived here. Other computers keep their copies as local items.
          await this.#save({
            ...row,
            shared: false,
            clock: bump(row.clock, this.peers.self()),
            digest: "",
            changed_by: this.peers.self(),
            changed_at: new Date(),
            note: "deleted",
          });
          await this.store.query("DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2", [
            this.store.owner,
            row.item_key,
          ]);
          changed = true;
          continue;
        }

        const digest = digestOf(value.payload);

        if (digest !== row.digest) {
          await this.#save({
            ...row,
            clock: bump(row.clock, this.peers.self()),
            digest,
            changed_by: this.peers.self(),
            changed_at: new Date(),
            tokens: value.tokens,
          });
          changed = true;
        } else if (canonicalJson(value.tokens) !== canonicalJson(row.tokens))
          await this.#save({ ...row, tokens: value.tokens });
      }

      if (changed) this.changed();

      return changed;
    });
  }

  /** Sends a peer every item it has not confirmed. `full`: everything shared (after a reconnect). */
  async push(node: string, full = false): Promise<void> {
    // A push already running sends again afterwards: it may have read the state before this change.
    if (this.#pushing.has(node)) {
      this.#again.add(node);

      return;
    }

    this.#pushing.add(node);

    try {
      for (let round = 0; round < 6; round++) {
        this.#again.delete(node);
        const items = await this.#exclusive(() => this.#outgoing(node, full && round === 0));

        if (!items.length) {
          if (this.#again.has(node)) continue;

          return;
        }

        const method = link.SharedConfigService.method.pushSharedConfig;
        let reply: link.SharedConfigReply | undefined;

        for await (const message of this.peers.call(
          node,
          method,
          create(link.SharedConfigPushSchema, { items }),
          AbortSignal.timeout(PUSH_TIMEOUT_MS),
        )) {
          reply = message as link.SharedConfigReply;
          break;
        }

        if (!reply) return;

        const resend = await this.#exclusive(async () => {
          let again = false;
          const sent = new Map(items.map((i) => [i.key, i]));

          for (const result of reply!.results) {
            const item = sent.get(result.key);

            if (!item) continue;

            if (result.outcome === "applied" || result.outcome === "same") {
              await this.#ack(node, item.key, item.digest, true);
              // The peer has exactly this value: take in its versions and drop any question about it.
              const row = this.#rows.get(item.key);

              if (row?.shared && row.digest === item.digest) {
                const clock = merge(row.clock, fromWire(result.clock));

                if (canonicalJson(clock) !== canonicalJson(row.clock)) await this.#save({ ...row, clock });

                const removed = await this.store.query(
                  "DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2 AND node_id=$3 RETURNING item_key",
                  [this.store.owner, item.key, node],
                );

                if (removed.length) this.changed();
              }
            } else if (result.outcome === "unshared") await this.#ack(node, item.key, undefined);
            else if (result.outcome === "secrets") {
              await this.#ack(node, item.key, undefined);
              again = true;
            }
          }

          return again;
        });

        if (!resend && !this.#again.has(node)) return;
      }
    } finally {
      this.#pushing.delete(node);
      this.#again.delete(node);
    }
  }

  async #outgoing(node: string, full: boolean): Promise<link.SharedItem[]> {
    const acks = new Map(
      (
        await this.store.query<{ item_key: string; digest: string; shared: boolean }>(
          "SELECT item_key,digest,shared FROM computer_shared_acks WHERE owner_user_id=$1::uuid AND node_id=$2",
          [this.store.owner, node],
        )
      ).map((a) => [a.item_key, a]),
    );

    const items: link.SharedItem[] = [];

    const rows = [...this.#rows.values()].sort(
      (a, b) => (ORDER[a.item_key.split(":")[0]!] ?? 9) - (ORDER[b.item_key.split(":")[0]!] ?? 9),
    );

    for (const row of rows) {
      const key = parseSharedKey(row.item_key);
      const ack = acks.get(row.item_key);

      if (!key) continue;

      const base = {
        key: row.item_key,
        clock: wireClock(row.clock),
        changedBy: row.changed_by,
        changedAtMs: BigInt(new Date(row.changed_at).getTime()),
        digest: row.digest,
      };

      if (!row.shared) {
        if (ack?.shared)
          items.push(
            create(link.SharedItemSchema, { ...base, shared: false, reason: row.note === "deleted" ? "deleted" : "" }),
          );
        continue;
      }

      if (!full && ack?.shared && ack.digest === row.digest) continue;
      const value = await this.read(key, row.tokens);

      if (!value || digestOf(value.payload) !== row.digest) continue; // the next scan versions it first
      const secrets = ack?.digest === row.digest ? [] : await this.#secretValues(value.refs);
      items.push(
        create(link.SharedItemSchema, { ...base, shared: true, payload: canonicalJson(value.payload), secrets }),
      );
    }

    return items;
  }

  // ------------------------------------------------------------------ another computer's changes

  /** A linked computer's push: apply, keep the newer local value, or ask the user. */
  async receive(node: string, push: link.SharedConfigPush): Promise<link.SharedConfigReply> {
    await this.scan();

    const reply = await this.#exclusive(async () => {
      const results: link.SharedItemResult[] = [];
      let changed = false;

      for (const item of push.items.slice(0, 500)) {
        const outcome = await this.#one(node, item).catch(failure);

        if (outcome.outcome !== "same" && outcome.outcome !== "newer") changed = true;
        const settled = outcome.outcome === "same" || outcome.outcome === "applied";
        results.push(
          create(link.SharedItemResultSchema, {
            key: item.key,
            outcome: outcome.outcome,
            digest: item.digest,
            message: outcome.message ?? "",
            ...(settled && { clock: wireClock(this.#row(item.key).clock) }),
          }),
        );
      }

      if (changed) this.changed();

      return create(link.SharedConfigReplySchema, { results });
    });

    return reply;
  }

  async #one(node: string, item: link.SharedItem): Promise<Outcome> {
    const key = parseSharedKey(item.key);

    if (!key || item.payload.length > 256 * 1024 || item.secrets.length > 64)
      return { outcome: "rejected", message: "unknown item" };
    const row = this.#row(item.key);
    const clock = fromWire(item.clock);

    if (!item.shared) {
      if (row.shared)
        await this.#save({
          ...row,
          shared: false,
          clock: merge(row.clock, clock),
          note: `${item.reason === "deleted" ? "deleted" : "unshared"}:${node}`,
        });
      await this.store.query(
        "DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2" +
          (row.shared ? "" : " AND node_id=$3"),
        row.shared ? [this.store.owner, item.key] : [this.store.owner, item.key, node],
      );
      await this.#ack(node, item.key, undefined);

      return { outcome: "unshared" };
    }

    // Stopped sharing here and not told yet: our unshare wins and reaches the sender next.
    if (
      !row.shared &&
      (
        await this.store.query(
          "SELECT 1 FROM computer_shared_acks WHERE owner_user_id=$1::uuid AND node_id=$2 AND item_key=$3 AND shared",
          [this.store.owner, node, item.key],
        )
      ).length
    )
      return { outcome: "unshared" };
    let payload: Payload;

    try {
      payload = JSON.parse(item.payload) as Payload;
    } catch {
      return { outcome: "rejected", message: "invalid item" };
    }

    if (digestOf(payload) !== item.digest) return { outcome: "rejected", message: "invalid item" };
    const current = await this.read(key, row.tokens);
    const local = current ? digestOf(current.payload) : "";
    const secrets = new Map(item.secrets.map((s) => [s.token, s.value]));

    if (local === item.digest) {
      // First share of an equal value: the sender's change is the last one known here.
      const author =
        row.shared && row.changed_by
          ? {}
          : { changed_by: item.changedBy, changed_at: new Date(Number(item.changedAtMs)) };

      await this.#save({
        ...row,
        ...author,
        shared: true,
        clock: merge(row.clock, clock),
        digest: local,
        tokens: current!.tokens,
        note: "",
      });
      await this.store.query(
        "DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2 AND node_id=$3",
        [this.store.owner, item.key, node],
      );
      await this.#ack(node, item.key, item.digest);

      return { outcome: "same" };
    }

    const order = row.shared ? compare(row.clock, clock) : current && !current.empty ? "concurrent" : "before";

    if (order === "after" || order === "equal") return { outcome: "newer" };

    if (order === "concurrent") {
      // Keep the other version (and its secrets, under this computer's key) until the user answers.
      const known = new Set(Object.values(row.tokens));

      if (tokensIn(payload).some((t) => !known.has(t) && !secrets.has(t))) return { outcome: "secrets" };
      const sealed = secrets.size ? encryptSecret(this.store.key, JSON.stringify(Object.fromEntries(secrets))) : null;
      await this.store.query(
        `INSERT INTO computer_shared_conflicts(owner_user_id,item_key,node_id,local_payload,remote_payload,remote_secrets,remote_clock,remote_digest,remote_changed_at)
        VALUES($1::uuid,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8,$9) ON CONFLICT(owner_user_id,item_key,node_id) DO UPDATE SET local_payload=excluded.local_payload,
        remote_payload=excluded.remote_payload,remote_secrets=coalesce(excluded.remote_secrets,computer_shared_conflicts.remote_secrets),remote_clock=excluded.remote_clock,
        remote_changed_at=excluded.remote_changed_at,remote_digest=excluded.remote_digest,
        detected_at=CASE WHEN computer_shared_conflicts.remote_digest=excluded.remote_digest THEN computer_shared_conflicts.detected_at ELSE now() END`,
        [
          this.store.owner,
          item.key,
          node,
          current ? JSON.stringify(current.payload) : null,
          item.payload,
          sealed,
          JSON.stringify(clock),
          item.digest,
          new Date(Number(item.changedAtMs)),
        ],
      );

      return { outcome: "conflict" };
    }

    const written = await this.#write(key, payload, secrets, current);

    if (written.outcome !== "applied") return written;
    const after = await this.read(key, written.tokens);
    await this.#save({
      ...row,
      shared: true,
      clock: merge(row.clock, clock),
      digest: after ? digestOf(after.payload) : item.digest,
      changed_by: item.changedBy,
      changed_at: new Date(Number(item.changedAtMs)),
      tokens: after?.tokens ?? {},
      note: "",
    });
    await this.store.query(
      "DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2 AND node_id=$3",
      [this.store.owner, item.key, node],
    );
    await this.#ack(node, item.key, item.digest);

    return { outcome: "applied" };
  }

  // ------------------------------------------------------------------ the user's choices

  async manage(operation: ui.SharedConfigOperation): Promise<ui.SharedConfigSnapshot> {
    await this.scan();
    const key = parseSharedKey(operation.key);

    if (!key) throw new ConnectError("This can't be shared", Code.InvalidArgument);
    await this.#exclusive(async () => {
      const row = this.#row(operation.key);
      const self = this.peers.self();

      if (operation.action === "share") {
        const value = await this.read(key, row.tokens);

        if (!value)
          throw new ConnectError(
            key.kind === "instance" ? "The built-in login is set up on each computer" : "Not found on this computer",
            Code.NotFound,
          );

        if (key.kind === "models" && !this.#row(`instance:${key.harness}:${key.id}`).shared && key.id !== "native")
          throw new ConnectError("Share the provider instance first", Code.FailedPrecondition);

        if (!row.shared)
          await this.#save({
            ...row,
            shared: true,
            clock: bump(row.clock, self),
            digest: digestOf(value.payload),
            changed_by: self,
            changed_at: new Date(),
            tokens: value.tokens,
            note: "",
          });
      } else if (operation.action === "unshare") {
        if (row.shared)
          await this.#save({
            ...row,
            shared: false,
            clock: bump(row.clock, self),
            changed_by: self,
            changed_at: new Date(),
            note: "",
          });
        await this.store.query("DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2", [
          this.store.owner,
          operation.key,
        ]);
      } else if (operation.action === "keep_local" || operation.action === "keep_remote") {
        const conflict = (
          await this.store.query<ConflictRow>(
            "SELECT * FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2 AND node_id=$3",
            [this.store.owner, operation.key, operation.nodeId],
          )
        )[0];

        if (!conflict) throw new ConnectError("This question was already answered", Code.NotFound);
        let value = await this.read(key, row.tokens);

        if (operation.action === "keep_remote") {
          const secrets = new Map(
            Object.entries(
              conflict.remote_secrets
                ? (JSON.parse(decryptSecret(this.store.key, conflict.remote_secrets)) as Record<string, string>)
                : {},
            ),
          );

          const written = await this.#write(key, conflict.remote_payload, secrets, value);

          if (written.outcome !== "applied")
            throw new ConnectError(
              written.message ? `Could not use that version: ${written.message}` : "Could not use that version",
              Code.FailedPrecondition,
            );
          value = await this.read(key, written.tokens);
        } else if (!value) throw new ConnectError("This computer's version no longer exists", Code.FailedPrecondition);
        // The answer is a new version that has seen both: it reaches the other computer and settles its question too.
        await this.#save({
          ...row,
          shared: true,
          clock: bump(merge(row.clock, conflict.remote_clock), self),
          digest: value ? digestOf(value.payload) : "",
          changed_by: self,
          changed_at: new Date(),
          tokens: value?.tokens ?? {},
          note: "",
        });
        await this.store.query(
          "DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2 AND node_id=$3",
          [this.store.owner, operation.key, operation.nodeId],
        );
      } else throw new ConnectError("Unknown sharing operation", Code.InvalidArgument);
    });
    this.changed();

    for (const node of this.peers.ready()) void this.push(node).catch(() => {});

    return this.snapshot();
  }

  // ------------------------------------------------------------------ what the UI shows

  async snapshot(): Promise<ui.SharedConfigSnapshot> {
    const self = this.peers.self();
    const items: ui.SharedConfigItem[] = [];

    for (const row of this.#rows.values()) {
      const key = parseSharedKey(row.item_key);

      if (!key || (!row.shared && !row.note.includes(":"))) continue;
      const [note, noteNode] = row.note.split(":");
      items.push(
        create(ui.SharedConfigItemSchema, {
          key: row.item_key,
          kind: key.kind,
          label: await this.#label(key),
          shared: row.shared,
          version: BigInt(Object.values(row.clock).reduce((a, b) => a + b, 0)),
          changedByNodeId: row.changed_by === self ? "" : row.changed_by,
          changedAtMs: BigInt(new Date(row.changed_at).getTime()),
          note: note ?? "",
          noteNodeId: noteNode ?? "",
        }),
      );
    }

    const conflicts: ui.SharedConfigConflict[] = [];

    for (const c of await this.store.query<ConflictRow>(
      "SELECT * FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid ORDER BY detected_at",
      [this.store.owner],
    )) {
      const key = parseSharedKey(c.item_key);

      if (!key) continue;
      const row = this.#row(c.item_key);
      const local = (await this.read(key, row.tokens))?.payload ?? c.local_payload ?? undefined;
      conflicts.push(
        create(ui.SharedConfigConflictSchema, {
          key: c.item_key,
          kind: key.kind,
          label: await this.#label(key),
          nodeId: c.node_id,
          detectedAtMs: BigInt(new Date(c.detected_at).getTime()),
          remoteChangedAtMs: BigInt(new Date(c.remote_changed_at).getTime()),
          fields: differences(local, c.remote_payload),
        }),
      );
    }

    return create(ui.SharedConfigSnapshotSchema, { items, conflicts, needsUpdateNodeIds: await this.peers.outdated() });
  }
  async #label(key: SharedKey): Promise<string> {
    if (key.kind === "settings") return SETTINGS_LABEL[key.section] ?? key.section;

    if (key.kind === "project")
      return (
        (await this.store.query<{ name: string }>("SELECT name FROM projects WHERE id=$1::uuid", [key.id]))[0]?.name ??
        "Project"
      );

    const label = (
      await this.store.query<{ label: string; built_in: boolean }>(
        "SELECT label,built_in FROM provider_instances WHERE harness=$1 AND id=$2",
        [key.harness, key.id],
      )
    )[0];

    const name = `${HARNESS_LABEL[key.harness] ?? key.harness} · ${label?.built_in ? "Device login" : label?.label || key.id}`;

    return key.kind === "models" ? `Models of ${name}` : name;
  }
  /** Publishes the current badges and conflicts to the UI (debounced). */
  changed() {
    clearTimeout(this.#publishTimer);
    this.#publishTimer = setTimeout(() => {
      void this.snapshot()
        .then((s) => this.host.publish(s))
        .catch(() => {});
    }, 50);
  }
  close() {
    clearTimeout(this.#publishTimer);
  }
}

// ------------------------------------------------------------------ conflict details

const ENUM_FIELDS = new Set(["colorScheme", "accent", "chatWidth", "provider", "permissionMode"]);
const ENUM_PREFIX = /^(COLOR_SCHEME|ACCENT_THEME|CHAT_WIDTH|PROVIDER|PERMISSION_MODE)_/;

const FIELD: Record<string, string> = {
  label: "Name",
  kind: "Connects with",
  baseUrl: "Endpoint",
  accentColor: "Accent",
  apiKey: "API key",
  env: "Variables",
  favorites: "Favourites",
  hidden: "Hidden models",
  shown: "Shown models",
  custom: "Custom models",
  colorScheme: "Color scheme",
  accent: "Accent",
  chatWidth: "Chat width",
  provider: "Provider",
  providerProfileId: "Instance",
  profileId: "Instance",
  permissionMode: "Permissions",
  models: "Models",
  timezone: "Time zone",
  model: "Model",
  effort: "Effort",
  threadTitleInstructions: "Title instructions",
  name: "Name",
};

function show(field: string, value: JsonValue | undefined, other?: JsonValue): string {
  // `other` is only given for the other computer's side: its key differs from this computer's.
  if (field === "apiKey") return value ? (other && other !== value ? "A different key" : "Set") : "Not set";

  if (value === undefined || value === null || value === "") return ENUM_FIELDS.has(field) ? "Default" : "Not set";

  if (field === "kind") return value === "endpoint" ? "Endpoint and API key" : "Device login";

  if (typeof value === "string" && ENUM_PREFIX.test(value)) {
    const words = value.replace(ENUM_PREFIX, "").toLowerCase().replaceAll("_", " ");

    return words[0]!.toUpperCase() + words.slice(1);
  }

  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    if (!value.length) return "None";

    return value
      .map((v) =>
        typeof v !== "object" || v === null
          ? String(v)
          : "secret" in v
            ? `${String(v["name"])} (secret)`
            : "name" in v
              ? `${String(v["name"])}=${String(v["value"] ?? "")}`
              : `${show("provider", (v as Payload)["provider"], undefined)}: ${String((v as Payload)["model"] ?? "")}`,
      )
      .join(", ");
  }

  return typeof value === "object" ? canonicalJson(value) : String(value);
}

/** The fields that differ, readable. Secret values never appear; only whether a key is set or another one. */
function differences(local: Payload | undefined, remote: Payload): ui.SharedConfigField[] {
  const names = [...new Set([...Object.keys(local ?? {}), ...Object.keys(remote)])];

  return names
    .filter((n) => canonicalJson(local?.[n] ?? null) !== canonicalJson(remote[n] ?? null))
    .map((n) =>
      create(ui.SharedConfigFieldSchema, {
        name: FIELD[n] ?? n,
        local: local ? show(n, local[n]) : "Not on this computer",
        remote: show(n, remote[n], local?.[n]),
      }),
    );
}
