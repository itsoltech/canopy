import { z } from "zod";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { sameIdentity, copyError } from "./safety.ts";

const receiptSchema = z.object({
  token: z.uuid(),
  parent: z.string(),
  target: z.string(),
  stage: z.string(),
  targetDev: z.number(),
  targetIno: z.number(),
  stageDev: z.number(),
  stageIno: z.number(),
  state: z.enum(["writing", "committing", "committed"]),
  digest: z.string().default(""),
});

export type CopyReceipt = z.infer<typeof receiptSchema>;

/** Receipts contain only our directory identities, never transferred file names or contents. */
export class CopyReceipts {
  readonly root: string;
  constructor(dataDir: string) {
    this.root = join(dataDir, "workspace-copies");
  }

  async save(receipt: CopyReceipt) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, receipt.token);
    const handle = await open(`${path}.part`, "w", 0o600);

    try {
      await handle.writeFile(JSON.stringify(receipt));
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(`${path}.part`, path);
  }

  async load(token: string) {
    if (!z.uuid().safeParse(token).success) throw copyError("Invalid transfer identifier.");
    const text = await readFile(join(this.root, token), "utf8").catch(() => undefined);

    return text ? receiptSchema.parse(JSON.parse(text)) : undefined;
  }

  async clean(receipt: CopyReceipt) {
    if (await sameIdentity(receipt.stage, receipt.stageDev, receipt.stageIno))
      await rm(receipt.stage, { recursive: true, force: true });

    if (await sameIdentity(receipt.target, receipt.targetDev, receipt.targetIno))
      await rm(receipt.target, { recursive: true, force: true });
    await rm(join(this.root, receipt.token), { force: true });
  }

  async recover() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });

    for (const token of await readdir(this.root)) {
      if (!z.uuid().safeParse(token).success) continue;
      const receipt = await this.load(token);

      if (!receipt || receipt.state === "committed") continue;

      if (receipt.state === "committing" && (await sameIdentity(receipt.target, receipt.stageDev, receipt.stageIno))) {
        await this.save({ ...receipt, state: "committed" });
      } else await this.clean(receipt);
    }
  }
}
