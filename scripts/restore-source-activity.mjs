#!/usr/bin/env node
/**
 * Живая активность узла-источника искусственного комплекта (работа № 5 раздела 01). Запускается на
 * источнике (`infra/restore/source.sh activity before|after`), ядро — по API, как пользователь.
 *
 *   before — до комплекта: снять и вернуть публикацию проекта (события в журнале аудита, цепочка
 *            не пуста; на момент T проект опубликован);
 *   after  — после комплекта: снять публикацию. Восстановленная на T копия видит проект
 *            опубликованным; учёт удалений 2.1.5 обязан снять его — это и проверяется после
 *            восстановления (`activity.json` рядом с выгрузкой аудита).
 *
 * Пароль одной демонстрационной учётной записи заменяется временным (данные искусственные).
 * Состояние — /var/lib/fifth-restore/activity.json.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import pg from 'pg';
import { parseEnvFile } from './lib/backup.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = parseEnvFile(join(ROOT, '.env'));
const STATE = '/var/lib/fifth-restore/activity.json';
const BASE = `http://127.0.0.1:${env.CORE_PORT || 4300}`;
const phase = process.argv[2];

const pool = new pg.Pool({ connectionString: env.DATABASE_URL_OWNER, max: 1 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

function client() {
  const jar = {};
  return {
    async call(path, { method = 'GET', body } = {}) {
      const headers = {
        cookie: Object.entries(jar)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      };
      if (body) headers['content-type'] = 'application/json';
      const csrf = jar[env.CSRF_COOKIE_NAME || 'ul_csrf'];
      if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body && JSON.stringify(body),
      });
      for (const c of r.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        jar[pair.slice(0, i)] = pair.slice(i + 1);
      }
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* не JSON */
      }
      return { status: r.status, json };
    },
  };
}

/** Вход владельца проекта временным паролем (данные искусственные). */
async function login(userId, email) {
  const password = randomBytes(18).toString('base64url');
  await q('UPDATE identity.users SET password_hash = $1 WHERE id = $2', [
    await argon2.hash(password, { type: argon2.argon2id }),
    userId,
  ]);
  const c = client();
  const r = await c.call('/v1/auth/login', { method: 'POST', body: { email, password } });
  if (r.status >= 300) throw new Error(`вход: HTTP ${r.status}`);
  return c;
}

try {
  if (phase === 'before') {
    // Демонстрационный основатель с проектом: email по логину комплекта (${login}@fifth.local).
    const people = JSON.parse(
      readFileSync(join(ROOT, 'fixtures', 'demo', 'people.json'), 'utf8'),
    ).people;
    const projects = JSON.parse(
      readFileSync(join(ROOT, 'fixtures', 'demo', 'projects.json'), 'utf8'),
    ).projects;
    let picked = null;
    for (const p of projects) {
      const person = people.find((x) => x.key === p.founder);
      const [row] = await q(
        `SELECT p.id, fp.user_id AS owner_user_id FROM lab.projects p
           JOIN lab.founders_projects fp ON fp.project_id = p.id AND fp.role = 'owner'
          WHERE p.title = $1 AND p.deleted_at IS NULL`,
        [p.title],
      );
      if (person && row) {
        picked = {
          email: `${person.login}@fifth.local`,
          userId: row.owner_user_id,
          projectId: row.id,
        };
        break;
      }
    }
    if (!picked) throw new Error('нет демонстрационного основателя с проектом');
    writeFileSync(STATE, JSON.stringify(picked));
    const c = await login(picked.userId, picked.email);
    const [{ listing_status: st }] = await q(
      'SELECT listing_status FROM lab.projects WHERE id = $1',
      [picked.projectId],
    );
    if (st === 'listed') {
      const u = await c.call(`/v1/projects/${picked.projectId}/listing`, { method: 'DELETE' });
      if (u.status >= 300)
        throw new Error(
          `снятие публикации: HTTP ${u.status} ${JSON.stringify(u.json).slice(0, 200)}`,
        );
    }
    const p = await c.call(`/v1/projects/${picked.projectId}/listing`, { method: 'POST' });
    if (p.status >= 300)
      throw new Error(`публикация: HTTP ${p.status} ${JSON.stringify(p.json).slice(0, 200)}`);
    const [{ n }] = await q('SELECT count(*)::int AS n FROM audit.events');
    console.log(`до комплекта: проект ${picked.projectId} опубликован; событий в журнале ${n}`);
  } else if (phase === 'after') {
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    const c = await login(s.userId, s.email);
    const u = await c.call(`/v1/projects/${s.projectId}/listing`, { method: 'DELETE' });
    if (u.status >= 300) throw new Error(`снятие публикации: HTTP ${u.status}`);
    const [{ listing_status: st }] = await q(
      'SELECT listing_status FROM lab.projects WHERE id = $1',
      [s.projectId],
    );
    writeFileSync(
      STATE,
      JSON.stringify({ ...s, afterT: { listing: st, at: new Date().toISOString() } }),
    );
    console.log(`после комплекта: публикация проекта ${s.projectId} снята (${st})`);
  } else {
    console.error('фазы: before, after');
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
