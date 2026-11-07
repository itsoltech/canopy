import { join } from "node:path";
import { closeSync, lstatSync, readdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { copiedFiles, CopyError, PrivateCopy } from "./copy.ts";
import { lines, openSource, sourceStat, type SourceFile } from "./read.ts";
import { decodeJsonObject, jsonObject } from "../providers/json.ts";

/**
 * Codex 0.166 validates the saved provider before accepting resume overrides. Normalize only a manifest-owned
 * rollout in Canopy's private home, including old imports. Keep its id, history, turn references and copy ownership.
 */
export function prepareImportedCodexResume(
  manifestPath: string,
  home: string,
  sessionId: string,
  provider: string,
): string | undefined {
  const owned = copiedFiles(manifestPath, home);
  const rel = owned?.files.find((file) => file.endsWith(`-${sessionId}.jsonl`));

  if (!owned || !rel) return undefined;
  const file = { root: home, path: join(home, rel) };
  const end = sourceStat(file).size;
  let changed = false;
  let offset = 0;

  for (const line of lines(file, 0, end)) {
    if (line.text === "" && line.end - line.offset > 1)
      throw new CopyError("the imported rollout has an unreadable record");

    if (normalize(line.text, sessionId, provider) !== line.text) changed = true;
    offset = line.end;
  }

  if (offset !== end) throw new CopyError("the imported rollout has an incomplete record");

  if (changed) {
    const copy = new PrivateCopy(home, manifestPath);

    try {
      copy.write(rel, normalizedLines(file, end, sessionId, provider));
      copy.commit(owned);
    } finally {
      copy.abort();
    }
  }

  refreshProviderIndex(home, file.path, sessionId, provider);

  return file.path;
}

/** Codex's paginated store prefers SQLite metadata even on path-based resume. Never open a source CLI database. */
function refreshProviderIndex(home: string, rolloutPath: string, sessionId: string, provider: string): void {
  for (const name of readdirSync(home).filter((entry) => /^state_\d+\.sqlite$/.test(entry))) {
    const path = join(home, name);

    // SQLite opens companion files too. Refuse links at every name it can use in this private home.
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const stat = lstatSync(path + suffix, { throwIfNoEntry: false });

      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1))
        throw new CopyError("the private Codex index contains a link or special file");
    }

    closeSync(openSource({ root: home, path }));
    const db = new Database(path, { readwrite: true, create: false });

    try {
      db.exec("PRAGMA busy_timeout = 5000");

      const columns = db
        .query<{ name: string }, []>("PRAGMA table_info(threads)")
        .all()
        .map((column) => column.name);

      if (!["id", "rollout_path", "model_provider"].every((column) => columns.includes(column))) continue;
      db.query("UPDATE threads SET model_provider = ? WHERE id = ? AND rollout_path = ? AND model_provider <> ?").run(
        provider,
        sessionId,
        rolloutPath,
        provider,
      );
    } finally {
      db.close();
    }
  }
}

function* normalizedLines(file: SourceFile, end: number, sessionId: string, provider: string): Generator<string> {
  let offset = 0;

  for (const line of lines(file, 0, end)) {
    yield `${normalize(line.text, sessionId, provider)}\n`;
    offset = line.end;
  }

  if (offset !== end) throw new CopyError("the imported rollout has an incomplete record");
}

function normalize(text: string, sessionId: string, provider: string): string {
  if (!text.trim()) return text;
  const record = decodeJsonObject(JSON.parse(text));
  const payload = jsonObject(record["payload"]);

  if (!payload) return text;

  if (record["type"] === "session_meta" && payload["id"] === sessionId) {
    if (payload["model_provider"] === provider) return text;

    return JSON.stringify({ ...record, payload: { ...payload, model_provider: provider } });
  } else if (
    record["type"] === "event_msg" &&
    payload["type"] === "thread_settings_applied" &&
    payload["thread_id"] === sessionId
  ) {
    const settings = jsonObject(payload["thread_settings"]);

    if (!settings || settings["model_provider_id"] === provider) return text;

    return JSON.stringify({
      ...record,
      payload: { ...payload, thread_settings: { ...settings, model_provider_id: provider } },
    });
  } else return text;
}
