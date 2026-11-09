/**
 * Учёт удалений после восстановления (2.1.5; согласовано Тэнком 09.11.2026).
 *
 * Применяется не каждое событие «при совпадении версии», а ИТОГОВОЕ состояние каждой
 * идентичности: последнее событие её категории по цепочке аудита после границы
 * восстановленной базы. Поэтому восстановленная версия объекта (v1 или v2) итог не меняет:
 * последнее «удалено» снимает объект при любом восстановленном поколении.
 *
 * Идентичность — что это за объект (проект + вид изображения, проект + получатель
 * доступа…). Поколение — конкретный экземпляр в этой идентичности (ключ файла, id выдачи):
 * «выдать → отозвать → выдать снова» даёт третье поколение. Версия — правка внутри
 * поколения (набор разрешений выдачи).
 *
 * Неоднозначность закрывает объект, а не пропускается: событие прежнего формата без
 * поколения — содержимое скрыто, доступ снят, объект в отчёте.
 *
 * Сырых токенов и секретов в событиях нет; то, что без них не воссоздать (подписка с
 * секретом, устройство с push-токеном), не воссоздаётся — «пересоздать» в отчёте.
 * Физически ничего не удаляется: ни объекты хранилища, ни комплекты копий.
 */

const has = (v) => v !== undefined && v !== null && v !== '';

/**
 * Категории: виды событий → идентичность и итоговое состояние. identity() бросает,
 * если идентичность по событию не установить — это неустранимая неоднозначность.
 */
export const CATEGORIES = {
  'project-media': {
    verbs: ['lab.project_media.set', 'lab.project_media.removed'],
    identity: (e) => need(e.subject_id, e.context.kind) && `${e.subject_id}:${e.context.kind}`,
    final: (e) =>
      e.verb === 'lab.project_media.removed'
        ? { present: false }
        : imageState(e, ['focusX', 'focusY']),
  },
  avatar: {
    verbs: ['identity.avatar.set', 'identity.avatar.removed'],
    identity: (e) => need(e.subject_id) && e.subject_id,
    final: (e) => (e.verb === 'identity.avatar.removed' ? { present: false } : imageState(e, [])),
  },
  'project-grant': {
    verbs: ['lab.project_access.granted', 'lab.project_access.revoked'],
    identity: (e) =>
      need(e.subject_id, e.context.granteeUserId) && `${e.subject_id}:${e.context.granteeUserId}`,
    final: (e) =>
      e.verb === 'lab.project_access.revoked'
        ? { present: false }
        : has(e.context.grantId) && Array.isArray(e.context.permissions)
          ? { present: true, generation: e.context.grantId, permissions: e.context.permissions }
          : { ambiguous: 'нет поколения выдачи (событие прежнего формата)' },
  },
  'project-exclusion': {
    verbs: ['lab.project_access.excluded', 'lab.project_access.exclusion_revoked'],
    identity: (e) =>
      need(e.subject_id, e.context.excludedUserId) && `${e.subject_id}:${e.context.excludedUserId}`,
    final: (e) =>
      e.verb === 'lab.project_access.exclusion_revoked'
        ? { present: false }
        : has(e.context.exclusionId)
          ? { present: true, generation: e.context.exclusionId }
          : { ambiguous: 'нет поколения исключения (событие прежнего формата)' },
  },
  role: {
    verbs: ['identity.role.granted', 'identity.role.revoked'],
    identity: (e) => need(e.subject_id, e.context.role) && `${e.subject_id}:${e.context.role}`,
    final: (e) => ({ present: e.verb === 'identity.role.granted' }),
  },
  capability: {
    verbs: ['identity.capability.granted', 'identity.capability.revoked'],
    identity: (e) =>
      need(e.subject_id, e.context.capability) && `${e.subject_id}:${e.context.capability}`,
    final: (e) =>
      e.verb === 'identity.capability.revoked'
        ? { present: false, reason: e.context.reason }
        : has(e.context.grantId) && has(e.context.reason)
          ? { present: true, generation: e.context.grantId, reason: e.context.reason }
          : { ambiguous: 'нет поколения полномочия (событие прежнего формата)' },
  },
  listing: {
    verbs: ['lab.listing.published', 'lab.listing.unpublished'],
    identity: (e) => need(e.subject_id) && e.subject_id,
    final: (e) => ({ status: e.verb === 'lab.listing.published' ? 'listed' : 'unlisted' }),
  },
  'project-visibility': {
    verbs: ['lab.project.visibility_changed'],
    identity: (e) => need(e.subject_id) && e.subject_id,
    final: (e) =>
      has(e.context.to) ? { visibility: e.context.to } : { ambiguous: 'нет новой видимости' },
  },
  'material-visibility': {
    verbs: ['lab.project_material.visibility_changed'],
    identity: (e) => need(e.context.materialId) && e.context.materialId,
    final: (e) =>
      has(e.context.visibility)
        ? { visibility: e.context.visibility }
        : { ambiguous: 'нет новой видимости' },
  },
  webhook: {
    verbs: ['integration.webhook.registered', 'integration.webhook.disabled'],
    identity: (e) => need(e.subject_id) && e.subject_id,
    final: (e) => ({ present: e.verb === 'integration.webhook.registered' }),
  },
  device: {
    verbs: ['comms.device.revoked'],
    identity: (e) => need(e.subject_id) && e.subject_id,
    final: () => ({ present: false }),
  },
  'service-account': {
    verbs: ['integration.service_account.suspended', 'integration.service_account.resumed'],
    identity: (e) => need(e.subject_id) && e.subject_id,
    final: (e) => ({
      status: e.verb === 'integration.service_account.suspended' ? 'suspended' : 'active',
    }),
  },
};

/** Ограничение первого пакета: избранное не учитывается (решение Тэнка 09.11). */
export const NOT_COVERED = ['lab.project.favorited', 'lab.project.unfavorited'];

function need(...values) {
  if (values.every(has)) return true;
  throw new Error('идентичность не установить');
}

function imageState(e, extra) {
  const c = e.context;
  const variants = c.variants && typeof c.variants === 'object' ? c.variants : null;
  const complete =
    has(c.masterKey) &&
    /^[0-9a-f]{64}$/.test(c.masterSha256 ?? '') &&
    variants &&
    Object.values(variants).every((v) => has(v?.key) && /^[0-9a-f]{64}$/.test(v?.sha256 ?? '')) &&
    ['mime', 'bytes', 'width', 'height', ...extra].every((k) => has(c[k]));
  if (!complete) return { ambiguous: 'нет ключа и SHA-256 файла (событие прежнего формата)' };
  return {
    present: true,
    generation: c.masterKey,
    file: {
      masterKey: c.masterKey,
      masterSha256: c.masterSha256,
      variants,
      mime: c.mime,
      bytes: c.bytes,
      width: c.width,
      height: c.height,
      ...(extra.length ? { focusX: c.focusX, focusY: c.focusY } : {}),
    },
  };
}

const BY_VERB = new Map(
  Object.entries(CATEGORIES).flatMap(([name, cat]) => cat.verbs.map((v) => [v, name])),
);

/**
 * План по событиям ПОСЛЕ границы, в порядке цепочки. Возвращает итог каждой
 * идентичности и события, которые он поглощает; неустранимые случаи — в unresolved.
 */
export function planReplay(events) {
  const items = new Map();
  const unresolved = [];
  for (const e of events) {
    const category = BY_VERB.get(e.verb);
    if (!category) continue;
    const cat = CATEGORIES[category];
    let identity;
    try {
      identity = cat.identity(e);
    } catch {
      unresolved.push({ eventId: e.id, verb: e.verb, reason: 'идентичность не установить' });
      continue;
    }
    const key = `${category}|${identity}`;
    const item = items.get(key) ?? { category, identity, eventIds: [], final: null };
    item.eventIds.push(e.id);
    item.final = { ...cat.final(e), eventId: e.id, actorId: e.actor_id, ts: e.ts };
    items.set(key, item);
  }
  return { items: [...items.values()], unresolved };
}

// ------------------------------------------------------------ применение

/**
 * Применить итог одной идентичности. client — соединение владельца в ОТКРЫТОЙ
 * транзакции; storage.exists(key, sha256) — есть ли в хранилище именно этот файл.
 * Возвращает {result, note}: applied | unchanged | closed | not-recreated.
 */
export async function applyItem(client, item, storage) {
  const fn = APPLY[item.category];
  return fn(client, item.identity, item.final, storage);
}

const changed = (n) => (n > 0 ? 'applied' : 'unchanged');

async function imageSlot(client, final, storage, { table, where, params, insert }) {
  const current = (await client.query(`SELECT master_key FROM ${table} WHERE ${where}`, params))
    .rows[0];
  const remove = async () =>
    (await client.query(`DELETE FROM ${table} WHERE ${where}`, params)).rowCount;
  if (final.ambiguous) {
    await remove();
    return { result: 'closed', note: final.ambiguous };
  }
  if (!final.present) return { result: changed(await remove()) };
  if (current?.master_key === final.file.masterKey) return { result: 'unchanged' };
  // Замена не воссоздаёт новый файл сама по себе: ссылка — только на файл, который
  // есть в хранилище с тем же SHA-256. Иначе прежний скрыт, слот пуст.
  const files = [
    [final.file.masterKey, final.file.masterSha256],
    ...Object.values(final.file.variants).map((v) => [v.key, v.sha256]),
  ];
  for (const [key, sha] of files) {
    if (!(await storage.exists(key, sha))) {
      await remove();
      return { result: 'closed', note: 'файл недоступен в хранилище — прежний скрыт, слот пуст' };
    }
  }
  await insert();
  return { result: 'applied' };
}

const stripSha = (variants) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(variants).map(([k, v]) => [
        k,
        { key: v.key, width: v.width, height: v.height },
      ]),
    ),
  );

const APPLY = {
  'project-media': (client, identity, final, storage) => {
    const [projectId, kind] = identity.split(':');
    return imageSlot(client, final, storage, {
      table: 'lab.project_media',
      where: 'project_id = $1 AND kind = $2',
      params: [projectId, kind],
      insert: async () => {
        const f = final.file;
        await client.query(
          `INSERT INTO lab.project_media
             (id, project_id, kind, master_key, variants, mime, bytes, width, height,
              focus_x, focus_y, uploaded_by, updated_at)
           VALUES (public.uuid_generate_v7(), $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, now())
           ON CONFLICT (project_id, kind) DO UPDATE
             SET master_key = EXCLUDED.master_key, variants = EXCLUDED.variants,
                 mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, width = EXCLUDED.width,
                 height = EXCLUDED.height, focus_x = EXCLUDED.focus_x,
                 focus_y = EXCLUDED.focus_y, uploaded_by = EXCLUDED.uploaded_by,
                 updated_at = now()`,
          [
            projectId,
            kind,
            f.masterKey,
            stripSha(f.variants),
            f.mime,
            f.bytes,
            f.width,
            f.height,
            f.focusX,
            f.focusY,
            final.actorId,
          ],
        );
      },
    });
  },
  avatar: (client, userId, final, storage) =>
    imageSlot(client, final, storage, {
      table: 'identity.user_avatars',
      where: 'user_id = $1',
      params: [userId],
      insert: async () => {
        const f = final.file;
        await client.query(
          `INSERT INTO identity.user_avatars
             (user_id, master_key, variants, mime, bytes, width, height, updated_at)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, now())
           ON CONFLICT (user_id) DO UPDATE
             SET master_key = EXCLUDED.master_key, variants = EXCLUDED.variants,
                 mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, width = EXCLUDED.width,
                 height = EXCLUDED.height, updated_at = now()`,
          [userId, f.masterKey, stripSha(f.variants), f.mime, f.bytes, f.width, f.height],
        );
      },
    }),
  'project-grant': (client, identity, final) =>
    generational(client, final, {
      table: 'lab.project_access_grants',
      match: 'project_id = $1 AND grantee_user_id = $2',
      params: identity.split(':'),
      revoke: 'revoked_at = now()',
      sameVersion: async () =>
        (
          await client.query(
            `UPDATE lab.project_access_grants SET permissions = $2::text[]
              WHERE id = $1 AND permissions IS DISTINCT FROM $2::text[]`,
            [final.generation, final.permissions],
          )
        ).rowCount,
      insert: async ([projectId, userId]) =>
        client.query(
          `INSERT INTO lab.project_access_grants
             (id, project_id, grantee_user_id, permissions, granted_by, granted_at)
           VALUES ($1, $2, $3, $4::text[], $5, $6)`,
          [final.generation, projectId, userId, final.permissions, final.actorId, final.ts],
        ),
    }),
  'project-exclusion': (client, identity, final) =>
    generational(client, final, {
      table: 'lab.project_access_exclusions',
      match: 'project_id = $1 AND excluded_user_id = $2',
      params: identity.split(':'),
      revoke: 'revoked_at = now()',
      insert: async ([projectId, userId]) =>
        client.query(
          `INSERT INTO lab.project_access_exclusions
             (id, project_id, excluded_user_id, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [final.generation, projectId, userId, final.actorId, final.ts],
        ),
    }),
  capability: (client, identity, final) =>
    generational(client, final, {
      table: 'identity.staff_capability_grants',
      match: 'user_id = $1 AND capability = $2',
      params: identity.split(':'),
      // revoked_by обязателен вместе с revoked_at; основание — из события.
      revoke: `revoked_at = now(), revoked_by = '${uuidOrNull(final.actorId)}'::uuid,
               revoke_reason = coalesce(revoke_reason, 'восстановление: учёт удалений')`,
      insert: async ([userId, capability]) =>
        client.query(
          `INSERT INTO identity.staff_capability_grants
             (id, user_id, capability, reason, granted_by, granted_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [final.generation, userId, capability, final.reason, final.actorId, final.ts],
        ),
    }),
  role: async (client, identity, final) => {
    const [userId, role] = identity.split(':');
    if (final.present) {
      const { rowCount } = await client.query(
        `INSERT INTO identity.user_roles (user_id, role, granted_by)
         SELECT $1, $2, $3 WHERE NOT EXISTS (
           SELECT 1 FROM identity.user_roles WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL)`,
        [userId, role, final.actorId],
      );
      return { result: changed(rowCount) };
    }
    const { rowCount } = await client.query(
      `UPDATE identity.user_roles SET revoked_at = now()
        WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL`,
      [userId, role],
    );
    return { result: changed(rowCount) };
  },
  listing: async (client, projectId, final) => {
    const { rowCount } = await client.query(
      `UPDATE lab.projects
          SET listing_status = $2,
              listed_at = CASE WHEN $2 = 'listed' THEN coalesce(listed_at, now()) ELSE listed_at END
        WHERE id = $1 AND listing_status IS DISTINCT FROM $2`,
      [projectId, final.status],
    );
    return { result: changed(rowCount) };
  },
  'project-visibility': async (client, projectId, final) => {
    if (final.ambiguous) {
      // Неизвестная видимость — самая закрытая.
      await client.query(`UPDATE lab.projects SET visibility = 'private' WHERE id = $1`, [
        projectId,
      ]);
      return { result: 'closed', note: final.ambiguous };
    }
    const { rowCount } = await client.query(
      `UPDATE lab.projects SET visibility = $2, visibility_changed_at = now()
        WHERE id = $1 AND visibility IS DISTINCT FROM $2`,
      [projectId, final.visibility],
    );
    return { result: changed(rowCount) };
  },
  'material-visibility': async (client, materialId, final) => {
    const visibility = final.ambiguous ? 'private' : final.visibility;
    const { rowCount } = await client.query(
      `UPDATE lab.project_materials SET visibility = $2
        WHERE id = $1 AND visibility IS DISTINCT FROM $2`,
      [materialId, visibility],
    );
    return final.ambiguous
      ? { result: 'closed', note: final.ambiguous }
      : { result: changed(rowCount) };
  },
  webhook: async (client, endpointId, final) => {
    if (final.present) {
      const { rows } = await client.query(
        `SELECT 1 FROM integration.webhook_endpoints WHERE id = $1`,
        [endpointId],
      );
      return rows.length
        ? { result: 'unchanged' }
        : { result: 'not-recreated', note: 'подписка с секретом не воссоздаётся — пересоздать' };
    }
    const { rowCount } = await client.query(
      `UPDATE integration.webhook_endpoints SET status = 'disabled'
        WHERE id = $1 AND status <> 'disabled'`,
      [endpointId],
    );
    return { result: changed(rowCount) };
  },
  device: async (client, deviceId) => {
    const { rowCount } = await client.query(
      `UPDATE comms.user_devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [deviceId],
    );
    return { result: changed(rowCount) };
  },
  'service-account': async (client, accountId, final) => {
    const { rowCount } = await client.query(
      `UPDATE integration.service_accounts SET status = $2, token_epoch = token_epoch + 1
        WHERE id = $1 AND status IS DISTINCT FROM $2`,
      [accountId, final.status],
    );
    return { result: changed(rowCount) };
  },
};

function uuidOrNull(v) {
  if (!/^[0-9a-f-]{36}$/i.test(v ?? '')) throw new Error('нет действующего лица для отзыва');
  return v;
}

/**
 * Поколенческий объект (выдача, исключение, полномочие): итог «есть поколение G» —
 * ровно G действует, другие поколения той же идентичности сняты; «нет» — сняты все;
 * неоднозначно — сняты все (закрыто).
 */
async function generational(client, final, spec) {
  const { table, match, params, revoke } = spec;
  if (final.ambiguous || !final.present) {
    const { rowCount } = await client.query(
      `UPDATE ${table} SET ${revoke} WHERE ${match} AND revoked_at IS NULL`,
      params,
    );
    return final.ambiguous
      ? { result: 'closed', note: final.ambiguous }
      : { result: changed(rowCount) };
  }
  let n = (
    await client.query(
      `UPDATE ${table} SET ${revoke} WHERE ${match} AND revoked_at IS NULL AND id <> $${params.length + 1}`,
      [...params, final.generation],
    )
  ).rowCount;
  const { rows } = await client.query(`SELECT revoked_at FROM ${table} WHERE id = $1`, [
    final.generation,
  ]);
  if (!rows.length) {
    await spec.insert(params);
    n++;
  } else if (rows[0].revoked_at !== null) {
    // Поколение снято в восстановленной копии, а итог его называет действующим —
    // противоречие порядка: закрыто, а не возвращено.
    return { result: 'closed', note: 'поколение снято в копии, итог называет действующим' };
  }
  if (spec.sameVersion) n += await spec.sameVersion();
  return { result: changed(n) };
}
