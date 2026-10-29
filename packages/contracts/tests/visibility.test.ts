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
  type ProjectViewer,
} from '../src';

const anon: ProjectViewer = { userId: null, roles: [] };
const investor: ProjectViewer = { userId: 'u1', roles: ['investor'] };
const member: ProjectViewer = { userId: 'u2', roles: ['founder'], member: true };
const admin: ProjectViewer = { userId: 'u3', roles: ['admin'] };
const removedRole: ProjectViewer = { userId: 'u5', roles: ['organizer', 'expert', 'showrunner'] };
const excluded: ProjectViewer = { ...investor, excluded: true };
const grantMaterials: ProjectViewer = { userId: 'u6', roles: ['investor'], grant: ['materials'] };
const grantProfile: ProjectViewer = { userId: 'u7', roles: ['investor'], grant: ['profile'] };
const grantExtendedKyc: ProjectViewer = {
  userId: 'u8',
  roles: ['investor'],
  grant: ['extended', 'profile'],
  kyc: true,
};

const all = AccessPermissionSchema.options;

describe('projectAudience — режим public', () => {
  it('аноним: тизер и профиль с аудиторией public; материалы — нет', () => {
    const p = { visibility: 'public' as const };
    expect(projectAudience(p, anon, 'teaser')).toBe('public');
    expect(projectAudience(p, anon, 'profile')).toBe('public');
    expect(projectAudience(p, anon, 'materials')).toBeNull();
    expect(projectAudience(p, anon, 'extended')).toBeNull();
  });
  it('инвестор видит то же, что аноним: допуска по роли нет (2.1-W05)', () => {
    const p = { visibility: 'public' as const };
    for (const perm of all) {
      expect(projectAudience(p, investor, perm)).toBe(projectAudience(p, anon, perm));
    }
  });
});

describe('projectAudience — режимы private и registered_investors', () => {
  it('private: никому вне команды; команда и админ — private', () => {
    const p = { visibility: 'private' as const };
    for (const perm of all) {
      expect(projectAudience(p, anon, perm)).toBeNull();
      expect(projectAudience(p, investor, perm)).toBeNull();
      expect(projectAudience(p, member, perm)).toBe('private');
      expect(projectAudience(p, admin, perm)).toBe('private');
      expect(projectAudience(p, removedRole, perm)).toBeNull();
    }
  });
  it('registered_investors: вне команды не открыто никому — допуска по роли нет', () => {
    const p = { visibility: 'registered_investors' as const };
    for (const perm of all) {
      expect(projectAudience(p, anon, perm)).toBeNull();
      expect(projectAudience(p, investor, perm)).toBeNull();
      expect(projectAudience(p, member, perm)).toBe('private');
    }
  });
});

describe('projectAudience — selected_investors: набор разрешений, не уровень', () => {
  const p = { visibility: 'selected_investors' as const };
  it('grant {materials}: тизер и материалы, профиль — нет', () => {
    expect(projectAudience(p, grantMaterials, 'teaser')).toBe('investors');
    expect(projectAudience(p, grantMaterials, 'materials')).toBe('investors');
    expect(projectAudience(p, grantMaterials, 'profile')).toBeNull();
  });
  it('grant {profile}: профиль без материалов; инвестор без grant — ничего', () => {
    expect(projectAudience(p, grantProfile, 'profile')).toBe('investors');
    expect(projectAudience(p, grantProfile, 'materials')).toBeNull();
    for (const perm of all) expect(projectAudience(p, investor, perm)).toBeNull();
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
      projectAudience({ visibility: 'public', blocked: true }, investor, 'profile'),
    ).toBeNull();
    expect(
      projectAudience({ visibility: 'public', deleted: true }, removedRole, 'profile'),
    ).toBeNull();
    expect(projectAudience({ visibility: 'public', deleted: true }, member, 'profile')).toBe(
      'private',
    );
    expect(projectAudience({ visibility: 'public', blocked: true }, admin, 'profile')).toBe(
      'private',
    );
  });
  it('удалённые роли (организатор, эксперт, шоураннер) прав не дают: как вошедший без допуска', () => {
    expect(projectAudience({ visibility: 'private' }, removedRole, 'teaser')).toBeNull();
    expect(projectAudience({ visibility: 'public' }, removedRole, 'teaser')).toBe('public');
    expect(projectAudience({ visibility: 'public' }, removedRole, 'materials')).toBeNull();
    expect(
      projectAudience({ visibility: 'registered_investors' }, removedRole, 'profile'),
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
