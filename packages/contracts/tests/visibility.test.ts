/**
 * Предикат аудитории (этап 5.7.1, план `заявка-04` §3.3) — зеркало
 * `lab.project_audience`. Паритет с SQL по той же матрице —
 * `database/tests/project-access.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  AccessPermissionSchema,
  ProjectVisibilitySchema,
  projectAudience,
  stricterVisibility,
  type AccessPermission,
  type ProjectViewer,
} from '../src';

const anon: ProjectViewer = { userId: null, roles: [] };
const investorGated: ProjectViewer = { userId: 'u1', roles: ['investor'], investorGate: true };
const investorNoGate: ProjectViewer = { userId: 'u1', roles: ['investor'], investorGate: false };
const member: ProjectViewer = { userId: 'u2', roles: ['founder'], member: true };
const admin: ProjectViewer = { userId: 'u3', roles: ['admin'] };
const reviewer: ProjectViewer = { userId: 'u4', roles: ['expert'], assignedReviewer: true };
const organizer: ProjectViewer = { userId: 'u5', roles: ['organizer'] };
const excluded: ProjectViewer = { ...investorGated, excluded: true };
const grantMaterials: ProjectViewer = { userId: 'u6', roles: ['investor'], grant: ['materials'] };
const grantProfile: ProjectViewer = { userId: 'u7', roles: ['investor'], grant: ['profile'] };
const grantExtendedKyc: ProjectViewer = {
  userId: 'u8',
  roles: ['investor'],
  grant: ['extended', 'profile'],
  kyc: true,
};

const all = AccessPermissionSchema.options;
const external: AccessPermission[] = ['teaser', 'profile', 'round', 'materials', 'passport'];

describe('projectAudience — режим public', () => {
  it('аноним: тизер, профиль и раунд с аудиторией public; материалы и паспорт — нет', () => {
    const p = { visibility: 'public' as const };
    expect(projectAudience(p, anon, 'teaser')).toBe('public');
    expect(projectAudience(p, anon, 'profile')).toBe('public');
    expect(projectAudience(p, anon, 'round')).toBe('public');
    expect(projectAudience(p, anon, 'materials')).toBeNull();
    expect(projectAudience(p, anon, 'passport')).toBeNull();
    expect(projectAudience(p, anon, 'extended')).toBeNull();
  });
  it('инвестор без допуска — как аноним; с допуском — investors на всё, кроме extended', () => {
    const p = { visibility: 'public' as const };
    for (const perm of external) {
      expect(projectAudience(p, investorNoGate, perm)).toBe(projectAudience(p, anon, perm));
      expect(projectAudience(p, investorGated, perm)).toBe('investors');
    }
    expect(projectAudience(p, investorGated, 'extended')).toBeNull();
  });
});

describe('projectAudience — режимы private и registered_investors', () => {
  it('private: никому вне команды; команда и админ — private, рецензент — platform', () => {
    const p = { visibility: 'private' as const };
    for (const perm of all) {
      expect(projectAudience(p, anon, perm)).toBeNull();
      expect(projectAudience(p, investorGated, perm)).toBeNull();
      expect(projectAudience(p, member, perm)).toBe('private');
      expect(projectAudience(p, admin, perm)).toBe('private');
      expect(projectAudience(p, reviewer, perm)).toBe(perm === 'extended' ? null : 'platform');
    }
  });
  it('registered_investors: только допущенный инвестор, анониму — ничего', () => {
    const p = { visibility: 'registered_investors' as const };
    for (const perm of external) {
      expect(projectAudience(p, anon, perm)).toBeNull();
      expect(projectAudience(p, investorNoGate, perm)).toBeNull();
      expect(projectAudience(p, investorGated, perm)).toBe('investors');
    }
    expect(projectAudience(p, investorGated, 'extended')).toBeNull();
  });
});

describe('projectAudience — selected_investors: набор разрешений, не уровень', () => {
  const p = { visibility: 'selected_investors' as const };
  it('grant {materials}: тизер и материалы, профиль и раунд — нет', () => {
    expect(projectAudience(p, grantMaterials, 'teaser')).toBe('investors');
    expect(projectAudience(p, grantMaterials, 'materials')).toBe('investors');
    expect(projectAudience(p, grantMaterials, 'profile')).toBeNull();
    expect(projectAudience(p, grantMaterials, 'round')).toBeNull();
    expect(projectAudience(p, grantMaterials, 'passport')).toBeNull();
  });
  it('grant {profile}: профиль без материалов; допущенный инвестор без grant — ничего', () => {
    expect(projectAudience(p, grantProfile, 'profile')).toBe('investors');
    expect(projectAudience(p, grantProfile, 'materials')).toBeNull();
    for (const perm of all) expect(projectAudience(p, investorGated, perm)).toBeNull();
  });
  it('extended — только с разрешением и KYC; аудитория всё равно investors', () => {
    expect(projectAudience(p, grantExtendedKyc, 'extended')).toBe('investors');
    expect(projectAudience(p, { ...grantExtendedKyc, kyc: false }, 'extended')).toBeNull();
    expect(projectAudience(p, grantProfile, 'extended')).toBeNull();
  });
});

describe('projectAudience — приоритеты', () => {
  it('исключение перекрывает режим и grant; удалённый и заблокированный закрыты внешним', () => {
    expect(projectAudience({ visibility: 'public' }, excluded, 'teaser')).toBeNull();
    expect(
      projectAudience(
        { visibility: 'selected_investors' },
        { ...grantProfile, excluded: true },
        'profile',
      ),
    ).toBeNull();
    expect(projectAudience({ visibility: 'public', blocked: true }, anon, 'teaser')).toBeNull();
    expect(
      projectAudience({ visibility: 'public', blocked: true }, investorGated, 'profile'),
    ).toBeNull();
    expect(
      projectAudience({ visibility: 'public', deleted: true }, reviewer, 'profile'),
    ).toBeNull();
    expect(projectAudience({ visibility: 'public', deleted: true }, member, 'profile')).toBe(
      'private',
    );
    expect(projectAudience({ visibility: 'public', blocked: true }, admin, 'profile')).toBe(
      'private',
    );
  });
  it('организатор: только тизер и только проект сезона', () => {
    expect(projectAudience({ visibility: 'private', inSeason: true }, organizer, 'teaser')).toBe(
      'public',
    );
    expect(
      projectAudience({ visibility: 'public', inSeason: false }, organizer, 'teaser'),
    ).toBeNull();
    expect(
      projectAudience({ visibility: 'public', inSeason: true }, organizer, 'profile'),
    ).toBeNull();
  });
  it('перечисления и строже-из-двух', () => {
    expect(ProjectVisibilitySchema.options).toEqual([
      'private',
      'public',
      'registered_investors',
      'selected_investors',
    ]);
    expect(stricterVisibility('public', 'investors')).toBe('investors');
    expect(stricterVisibility('private', 'public')).toBe('private');
  });
});
