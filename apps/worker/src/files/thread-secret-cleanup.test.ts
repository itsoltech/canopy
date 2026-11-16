import { expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ItemDeltaField, ThreadSecretDeliverySchema } from "@canopy/contracts";
import { isBigInt, tempDirs } from "@canopy/testing";
import { ManagedRuntime } from "effect";
import { Journal } from "../journal/index.ts";
import { ThreadSecretFiles } from "../runtime/thread-secrets.ts";

const temp = tempDirs();

test("closing private secret files keeps another thread's grants and redacts late durable output", async () => {
  const data = temp("canopy-secret-close-");
  const workspace = join(data, "workspace");
  mkdirSync(workspace);
  const secrets = new ThreadSecretFiles(data);
  const archived = crypto.randomUUID();
  const survivor = crypto.randomUUID();
  const value = `private-${crypto.randomUUID()}`;

  const delivery = (threadId: string, secret: string) =>
    create(ThreadSecretDeliverySchema, {
      threadId,
      requestId: crypto.randomUUID(),
      revision: 1,
      cwd: workspace,
      value: secret,
      expiresAt: timestampFromDate(new Date(Date.now() + 60_000)),
    });

  const archivedFile = secrets.apply(delivery(archived, value));
  const survivorFile = secrets.apply(delivery(survivor, `other-${crypto.randomUUID()}`));
  const journal = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));

  const append = (chunk: string) =>
    journal.runPromise(
      Journal.use((j) =>
        j.append(archived, {
          turnId: "turn",
          rawJson: JSON.stringify({ output: chunk }),
          body: { case: "itemDelta", value: { itemId: "echo", field: ItemDeltaField.OUTPUT, chunk } },
        }),
      ),
    );

  try {
    expect(archivedFile.applied).toBe(true);
    expect(survivorFile.applied).toBe(true);
    expect(statSync(archivedFile.file).mode & 0o777).toBe(0o600);
    await append(value.slice(0, 8));
    secrets.closeThread(archived);
    expect(existsSync(join(secrets.root, archived))).toBe(false);
    expect(existsSync(survivorFile.file)).toBe(true);
    const delta = await append(value.slice(8));
    expect(delta.rawJson).toBe("");
    expect(delta.body.case === "itemDelta" && delta.body.value.chunk).toBe("");

    const completed = await journal.runPromise(
      Journal.use((j) =>
        j.append(archived, {
          turnId: "turn",
          rawJson: JSON.stringify({ output: value }),
          body: {
            case: "itemCompleted",
            value: { item: { itemId: "echo", content: { case: "commandExecution", value: {} } } },
          },
        }),
      ),
    );

    expect(JSON.stringify(completed, (_key, field) => (isBigInt(field) ? String(field) : field))).not.toContain(value);
    expect(
      completed.body.case === "itemCompleted" &&
        completed.body.value.item?.content.case === "commandExecution" &&
        completed.body.value.item.content.value.output,
    ).toBe("[REDACTED]");

    // A fresh item starts after cleanup, without a pre-existing redactor buffer.
    const late = await journal.runPromise(
      Journal.use((j) =>
        j.append(archived, {
          rawJson: JSON.stringify({ value }),
          body: { case: "notice", value: { message: value } },
        }),
      ),
    );

    expect(late.body.case === "notice" && late.body.value.message).toBe("[REDACTED]");
    expect(late.rawJson).toBe("");
  } finally {
    await journal.dispose();
    secrets.close();
  }
});

test("late secret deliveries cannot rematerialize an archived thread until it explicitly reopens", async () => {
  const data = temp("canopy-secret-delivery-fence-");
  const workspace = join(data, "workspace");
  mkdirSync(workspace);
  const secrets = new ThreadSecretFiles(data);
  const threadId = crypto.randomUUID();

  const delivery = create(ThreadSecretDeliverySchema, {
    threadId,
    requestId: crypto.randomUUID(),
    revision: 4,
    cwd: workspace,
    value: `private-${crypto.randomUUID()}`,
    expiresAt: timestampFromDate(new Date(Date.now() + 200)),
  });

  try {
    expect(secrets.apply(delivery).applied).toBe(true);
    secrets.closeThread(threadId);
    expect(secrets.apply({ ...delivery, revision: 5 }).applied).toBe(false);
    expect(existsSync(join(secrets.root, threadId))).toBe(false);
    expect(secrets.apply({ ...delivery, revision: 6, remove: true }).applied).toBe(true);
    expect(existsSync(join(secrets.root, threadId))).toBe(false);
    secrets.openThread(threadId);
    expect(secrets.apply({ ...delivery, revision: 5 }).applied).toBe(false);
    expect(existsSync(join(secrets.root, threadId))).toBe(false);

    const reopened = secrets.apply({
      ...delivery,
      revision: 7,
      expiresAt: timestampFromDate(new Date(Date.now() + 60_000)),
    });

    expect(reopened.applied).toBe(true);
    expect(existsSync(reopened.file)).toBe(true);
    expect(secrets.redactionValues()).toContain(delivery.value);
    await Bun.sleep(250);
    expect(existsSync(reopened.file)).toBe(true);
  } finally {
    secrets.close();
  }
});
