import { skillName } from "@canopy/domain/skill-artifact";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { Invalid, NotFound, one, type Fx } from "../store/errors.ts";

export const MAX_BOT_SKILLS = 64;
export const MAX_SKILL_DESCRIPTION = 256;
export const MAX_SKILL_INSTRUCTIONS = 16_000;

type Sql = SqlClient.SqlClient;

type SkillSummary = { name: string; description: string; revision: number };

type Skill = SkillSummary & { instructions: string };

type SkillInput = Omit<Skill, "revision"> & { expectedRevision?: number };

export function validSkillText(value: string, maximum: number) {
  return value.length <= maximum && value.trim().length > 0 && !value.includes("\0") && value.isWellFormed();
}

const invalidName = () => new Invalid("Use a lowercase hyphenated skill name of up to 64 characters.");
const invalidRevision = () => new Invalid("The skill changed or was deleted. Read its current revision and try again.");
const validRevision = (n: number) => Number.isInteger(n) && n >= 1 && n <= 2_147_483_647;

function ownedSkills(sql: Sql, ownerId: string, botId: string) {
  return sql`FROM bot_skills s JOIN bots b ON b.id=s.bot_id
    WHERE b.owner_user_id=${ownerId}::uuid AND b.id=${botId}::uuid AND b.deleted_at IS NULL
      AND b.moved_to IS NULL AND s.instructions IS NOT NULL`;
}

export function listBotSkills(sql: Sql, ownerId: string, botId: string) {
  return sql<SkillSummary>`SELECT s.name, s.description, s.revision ${ownedSkills(sql, ownerId, botId)} ORDER BY s.name`;
}

export function readBotSkill(sql: Sql, ownerId: string, botId: string, name: string): Fx<Skill> {
  if (!skillName(name)) return Effect.fail(invalidName());

  return sql<Skill>`SELECT s.name, s.description, s.instructions, s.revision
    ${ownedSkills(sql, ownerId, botId)} AND s.name=${name}`.pipe(Effect.flatMap((rows) => one(rows, "skill")));
}

/** Move and archive use the same parent lock. It also serializes admissions against the per-bot limit. */
function lockBot(sql: Sql, ownerId: string, botId: string) {
  return sql`SELECT id FROM bots WHERE id=${botId}::uuid AND owner_user_id=${ownerId}::uuid
    AND deleted_at IS NULL AND archived_at IS NULL AND moved_to IS NULL FOR UPDATE`.pipe(
    Effect.flatMap((rows) => (rows.length ? Effect.void : Effect.fail(new NotFound("active bot not found")))),
  );
}

export function saveBotSkill(sql: Sql, ownerId: string, botId: string, input: SkillInput) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const { name, description, instructions, expectedRevision } = input;

      if (!skillName(name)) return yield* Effect.fail(invalidName());

      if (!validSkillText(description, MAX_SKILL_DESCRIPTION))
        return yield* Effect.fail(new Invalid("Provide a skill description of 1 to 256 characters."));

      if (!validSkillText(instructions, MAX_SKILL_INSTRUCTIONS))
        return yield* Effect.fail(new Invalid("Provide skill instructions of 1 to 16000 characters."));

      yield* lockBot(sql, ownerId, botId);

      if (expectedRevision !== undefined) {
        if (!validRevision(expectedRevision)) return yield* Effect.fail(new Invalid("Invalid expected revision."));

        const rows = yield* sql<Skill>`UPDATE bot_skills SET description=${description}, instructions=${instructions},
          revision=revision+1 WHERE bot_id=${botId}::uuid AND name=${name} AND revision=${expectedRevision}
          AND instructions IS NOT NULL RETURNING name, description, instructions, revision`;

        return rows[0] ?? (yield* Effect.fail(invalidRevision()));
      }

      const [count] = yield* sql<{ total: number }>`SELECT count(*)::int AS total FROM bot_skills
        WHERE bot_id=${botId}::uuid AND instructions IS NOT NULL`;

      if (count && count.total >= MAX_BOT_SKILLS)
        return yield* Effect.fail(new Invalid("A bot can have up to 64 skills."));

      const rows = yield* sql<Skill>`INSERT INTO bot_skills(bot_id,name,description,instructions,revision)
        VALUES (${botId}::uuid,${name},${description},${instructions},1)
        ON CONFLICT (bot_id,name) DO UPDATE SET description=excluded.description, instructions=excluded.instructions,
          revision=bot_skills.revision+1 WHERE bot_skills.instructions IS NULL
        RETURNING name, description, instructions, revision`;

      return (
        rows[0] ?? (yield* Effect.fail(new Invalid("A skill with this name already exists. Read it before updating.")))
      );
    }),
  );
}

export function deleteBotSkill(sql: Sql, ownerId: string, botId: string, name: string, expectedRevision: number) {
  return sql.withTransaction(
    Effect.gen(function* () {
      if (!skillName(name)) return yield* Effect.fail(invalidName());

      if (!validRevision(expectedRevision)) return yield* Effect.fail(new Invalid("Invalid expected revision."));
      yield* lockBot(sql, ownerId, botId);

      const rows = yield* sql`UPDATE bot_skills SET description=NULL, instructions=NULL
        WHERE bot_id=${botId}::uuid AND name=${name} AND revision=${expectedRevision} AND instructions IS NOT NULL
        RETURNING name`;

      if (!rows.length) return yield* Effect.fail(invalidRevision());
    }),
  );
}
