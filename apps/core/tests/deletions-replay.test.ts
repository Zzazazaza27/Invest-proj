import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — модуль скриптов на JS без деклараций.
import * as replay from '../../../scripts/lib/deletions-replay.mjs';
// @ts-expect-error — модуль скриптов на JS без деклараций.
import * as exp from '../../../scripts/lib/audit-export.mjs';

/**
 * Учёт удалений после восстановления (2.1.5; согласовано Тэнком 09.11.2026): итог по
 * идентичности, поколения, неоднозначность — закрыто; выгрузка — подпись, продолжение
 * серии от контрольной точки, цепочка событий.
 */

let n = 0;
const ev = (verb: string, subject: string, context: Record<string, unknown> = {}) => ({
  id: `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
  ts: new Date(Date.UTC(2026, 10, 9, 10, 0, n)).toISOString(),
  verb,
  actor_id: '11111111-1111-7111-8111-111111111111',
  subject_id: subject,
  context,
});
const P = 'aaaaaaaa-0000-7000-8000-000000000001';
const U = 'bbbbbbbb-0000-7000-8000-000000000001';
const sha = 'a'.repeat(64);
const image = (key: string) => ({
  kind: 'logo',
  masterKey: key,
  masterSha256: sha,
  variants: { card: { key: `${key}-card`, width: 10, height: 10, sha256: sha } },
  mime: 'image/png',
  bytes: 10,
  width: 10,
  height: 10,
  focusX: 0.5,
  focusY: 0.5,
});

describe('итог по идентичности', () => {
  it('копия с v1, затем v2 и удаление — итог «удалено» при любом поколении', () => {
    const { items } = replay.planReplay([
      ev('lab.project_media.set', P, image('v2')),
      ev('lab.project_media.removed', P, { kind: 'logo', masterKey: 'v2' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].final.present).toBe(false);
    expect(items[0].eventIds).toHaveLength(2);
  });

  it('замена — итог с ключом и SHA-256 нового файла; без них — закрыто', () => {
    const ok = replay.planReplay([ev('lab.project_media.set', P, image('v2'))]).items[0];
    expect(ok.final).toMatchObject({ present: true, generation: 'v2' });
    const old = replay.planReplay([
      ev('lab.project_media.set', P, {
        kind: 'logo',
        mime: 'image/png',
        width: 1,
        height: 1,
        bytes: 1,
      }),
    ]).items[0];
    expect(old.final.ambiguous).toBeTruthy();
  });

  it('выдать → отозвать → выдать снова: итог — третье поколение', () => {
    const { items } = replay.planReplay([
      ev('lab.project_access.granted', P, {
        grantId: 'g1',
        granteeUserId: U,
        permissions: ['profile'],
      }),
      ev('lab.project_access.revoked', P, { grantId: 'g1', granteeUserId: U }),
      ev('lab.project_access.granted', P, {
        grantId: 'g3',
        granteeUserId: U,
        permissions: ['materials'],
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].final).toMatchObject({
      present: true,
      generation: 'g3',
      permissions: ['materials'],
    });
  });

  it('выдача прежнего формата без поколения — закрыто, а не пропуск', () => {
    const { items } = replay.planReplay([
      ev('lab.project_access.granted', P, { granteeUserId: U, permissions: ['profile'] }),
    ]);
    expect(items[0].final.ambiguous).toBeTruthy();
  });

  it('исключение и его снятие, повторная публикация — последнее событие', () => {
    const { items } = replay.planReplay([
      ev('lab.project_access.excluded', P, { exclusionId: 'e1', excludedUserId: U }),
      ev('lab.project_access.exclusion_revoked', P, { exclusionId: 'e1', excludedUserId: U }),
      ev('lab.listing.unpublished', P),
      ev('lab.listing.published', P),
    ]);
    const by = Object.fromEntries(items.map((i: { category: string }) => [i.category, i]));
    expect(by['project-exclusion'].final.present).toBe(false);
    expect(by.listing.final.status).toBe('listed');
  });

  it('идентичность не установить — неустранимо; посторонние события не учитываются', () => {
    const { items, unresolved } = replay.planReplay([
      ev('lab.project_access.revoked', P, { grantId: 'g1' }),
      ev('lab.project.updated', P, { fields: ['title'] }),
    ]);
    expect(items).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
  });
});

describe('выгрузка: подпись, продолжение, цепочка', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const cipher = Buffer.from('шифротекст');
  const manifest = (over: Record<string, unknown>) => ({
    format: exp.FORMAT,
    databaseId: 'db1',
    seq: 1,
    prevManifestSha256: null,
    from: { afterEventId: null, afterRowHash: null },
    to: { eventId: 'e2', ts: '2026-11-09T10:00:00.000000Z', rowHash: 'h2' },
    count: 2,
    plainSha256: 'x',
    cipherSha256: exp.sha256Hex(cipher),
    checkedAt: '2026-11-09T10:00:01.000000Z',
    ...over,
  });
  const signed = (m: object) => exp.signManifest(m, privateKey);
  const first = signed(manifest({}));
  const cp1 = exp.acceptPortion(null, first.bytes, first.signature, cipher, pub).point;

  it('первая порция начинает серию; следующая продолжает контрольную точку', () => {
    const m2 = signed(
      manifest({
        seq: 2,
        prevManifestSha256: cp1.manifestSha256,
        from: { afterEventId: 'e2', afterRowHash: 'h2' },
        to: { eventId: 'e2', ts: 'x', rowHash: 'h2' },
        count: 0,
        checkedAt: '2026-11-09T11:00:00.000000Z',
      }),
    );
    expect(exp.acceptPortion(cp1, m2.bytes, m2.signature, cipher, pub).point.seq).toBe(2);
  });

  it.each([
    ['старая порция вместо новой', { seq: 1 }],
    ['пропуск порции', { seq: 3 }],
    [
      'усечённый хвост: начало не с хвоста точки',
      { seq: 2, from: { afterEventId: 'e1', afterRowHash: 'h1' } },
    ],
    ['другая база', { seq: 2, databaseId: 'db2' }],
    ['время проверки раньше точки', { seq: 2, checkedAt: '2026-11-09T09:00:00.000000Z' }],
  ])('%s — отвергнута', (_n, over: Record<string, unknown>) => {
    const next: Record<string, unknown> = {
      seq: 2,
      prevManifestSha256: cp1.manifestSha256,
      from: { afterEventId: 'e2', afterRowHash: 'h2' },
    };
    const m = signed(manifest({ ...next, ...over }));
    expect(() => exp.acceptPortion(cp1, m.bytes, m.signature, cipher, pub)).toThrow();
  });

  it('подпись чужим ключом или изменённая опись — отвергнута', () => {
    const other = generateKeyPairSync('ed25519');
    const forged = exp.signManifest(manifest({}), other.privateKey);
    expect(() => exp.acceptPortion(null, forged.bytes, forged.signature, cipher, pub)).toThrow(
      'подпись',
    );
    const tampered = Buffer.from(first.bytes.toString().replace('"count":2', '"count":3'));
    expect(() => exp.acceptPortion(null, tampered, first.signature, cipher, pub)).toThrow(
      'подпись',
    );
  });

  it('шифротекст не по описи — отвергнут', () => {
    expect(() =>
      exp.acceptPortion(null, first.bytes, first.signature, Buffer.from('другой'), pub),
    ).toThrow('шифротекст');
  });

  it('цепочка событий: разрыв и чужой хвост ловятся', () => {
    const chain = [
      { id: 'e1', prev_hash: null, row_hash: 'h1' },
      { id: 'e2', prev_hash: 'h1', row_hash: 'h2' },
    ];
    expect(exp.checkEventChain(chain, null, 'h2')).toBeNull();
    expect(exp.checkEventChain([chain[1]], null, 'h2')).toMatch('разрыв');
    expect(exp.checkEventChain(chain, null, 'h9')).toMatch('хвост');
  });
});
