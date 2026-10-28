import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable, Kysely, Updateable } from 'kysely';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { SessionTable } from 'src/schema/tables/session.table.js';
import { asUuid } from 'src/utils/database.js';
import { jsonObjectFrom } from 'src/utils/sql-json.js';

@Injectable()
export class SessionRepository {
  private logger = new Logger(SessionRepository.name);

  constructor(@InjectKysely() private db: Kysely<DB>) {}

  // diagnostics (h8/h9): auth-rejection forensics. Staged so a single log line
  // names the failing predicate: token-buffer match, session row, user row.
  async debugState(hashedToken?: Buffer) {
    const rows = await this.db
      .selectFrom('session')
      .select(['id', 'createdAt', 'expiresAt', 'userId', 'token'])
      .execute();
    const userCount = await this.db
      .selectFrom('user')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .executeTakeFirst();
    let tokenMatches = -1;
    let matchedUserId: string | null = null;
    let userRow: { id: string; deletedAt: Date | null } | undefined;
    if (hashedToken) {
      const matches = await this.db
        .selectFrom('session')
        .select(['id', 'userId'])
        .where('token', '=', hashedToken)
        .execute();
      tokenMatches = matches.length;
      matchedUserId = matches[0]?.userId ?? rows[0]?.userId ?? null;
      if (matchedUserId) {
        userRow = await this.db
          .selectFrom('user')
          .select(['id', 'deletedAt'])
          .where('id', '=', matchedUserId)
          .executeTakeFirst();
      }
    }
    return {
      count: rows.length,
      rows: rows.map((r) => ({
        id: r.id,
        created: r.createdAt,
        expires: r.expiresAt,
        userId: r.userId,
        tokenLen: r.token?.byteLength ?? -1,
        tokenHash: r.token ? Buffer.from(r.token).toString('hex').slice(0, 12) : null,
      })),
      tokenMatches,
      matchedUserId,
      userRow: userRow ? { id: userRow.id, deletedAt: userRow.deletedAt } : null,
      userCount: userCount?.c ?? -1,
    };
  }

  private traceDelete(op: string) {
    this.logger.warn(
      `[sessiontrace] ${op} called at=${(new Error('sessiontrace').stack ?? '').split('\n').slice(2, 8).join(' | ')}`,
    );
  }

  cleanup() {
    this.traceDelete('cleanup');
    return this.db
      .deleteFrom('session')
      .where((eb) =>
        eb.or([
          eb('updatedAt', '<=', DateTime.now().minus({ days: 90 }).toJSDate()),
          eb.and([eb('expiresAt', 'is not', null), eb('expiresAt', '<=', DateTime.now().toJSDate())]),
        ]),
      )
      .returning(['id', 'deviceOS', 'deviceType'])
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.db
      .selectFrom('session')
      .select(['id', 'expiresAt', 'pinExpiresAt', 'oauthBearerToken'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async isPendingSyncReset(id: string) {
    const result = await this.db
      .selectFrom('session')
      .select(['isPendingSyncReset'])
      .where('id', '=', id)
      .executeTakeFirst();
    return result?.isPendingSyncReset ?? false;
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  getByToken(token: Buffer) {
    return this.db
      .selectFrom('session')
      .select((eb) => [
        ...columns.authSession,
        jsonObjectFrom(
          eb
            .selectFrom('user')
            .select(columns.authUser)
            .whereRef('user.id', '=', 'session.userId')
            .where('user.deletedAt', 'is', null),
        ).as('user'),
      ])
      .where('session.token', '=', token)
      .where((eb) =>
        eb.or([eb('session.expiresAt', 'is', null), eb('session.expiresAt', '>', DateTime.now().toJSDate())]),
      )
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getByUserId(userId: string) {
    return this.db
      .selectFrom('session')
      .innerJoin('user', (join) => join.onRef('user.id', '=', 'session.userId').on('user.deletedAt', 'is', null))
      .selectAll('session')
      .where('session.userId', '=', userId)
      .where((eb) =>
        eb.or([eb('session.expiresAt', 'is', null), eb('session.expiresAt', '>', DateTime.now().toJSDate())]),
      )
      .orderBy('session.updatedAt', 'desc')
      .orderBy('session.createdAt', 'desc')
      .execute();
  }

  create(dto: Insertable<SessionTable>) {
    return this.db.insertInto('session').values(dto).returningAll().executeTakeFirstOrThrow();
  }

  update(id: string, dto: Updateable<SessionTable>) {
    return this.db
      .updateTable('session')
      .set(dto)
      .where('session.id', '=', asUuid(id))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    this.traceDelete('delete');
    await this.db.deleteFrom('session').where('id', '=', asUuid(id)).execute();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, excludeId: DummyValue.UUID }] })
  async invalidateAll({ userId, excludeId }: { userId: string; excludeId?: string }) {
    this.traceDelete('invalidateAll');
    await this.db
      .deleteFrom('session')
      .where('userId', '=', userId)
      .$if(!!excludeId, (qb) => qb.where('id', '!=', excludeId!))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.STRING, DummyValue.STRING] })
  async invalidateOAuth({ oauthSid, oauthId }: { oauthSid?: string; oauthId?: string }): Promise<string[]> {
    this.traceDelete('invalidateOAuth');
    let query = this.db.deleteFrom('session').returning('session.id');

    if (oauthSid && oauthId) {
      query = query
        .using('user')
        .whereRef('user.id', '=', 'session.userId')
        .where('session.oauthSid', '=', oauthSid)
        .where('user.oauthId', '=', oauthId);
    } else if (!oauthSid && oauthId) {
      query = query.using('user').whereRef('user.id', '=', 'session.userId').where('user.oauthId', '=', oauthId);
    } else if (oauthSid && !oauthId) {
      query = query.where('session.oauthSid', '=', oauthSid);
    } else {
      throw new Error('Invalid arguments: at least one of oauthSid or oauthId must be present');
    }

    const deletedRows = await query.execute();
    return deletedRows.map((row) => row.id);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async lockAll(userId: string) {
    await this.db.updateTable('session').set({ pinExpiresAt: null }).where('userId', '=', userId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async resetSyncProgress(sessionId: string) {
    await this.db.transaction().execute((tx) => {
      return Promise.all([
        tx.updateTable('session').set({ isPendingSyncReset: false }).where('id', '=', sessionId).execute(),
        tx.deleteFrom('session_sync_checkpoint').where('sessionId', '=', sessionId).execute(),
      ]);
    });
  }
}
