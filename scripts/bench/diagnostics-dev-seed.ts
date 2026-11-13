import { seedClient } from "./seed-client.ts";

process.send?.(await seedClient(process.env));
