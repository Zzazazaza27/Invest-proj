#!/usr/bin/env node
/**
 * Сценарий на технической test-1: что на самом деле получает новый человек. Только наблюдение:
 * ничего не исправляет, письма не уходят (MAIL_TRANSPORT=none), адрес зарезервированный.
 *
 *   node scripts/probe-account-path.mjs
 *
 * Пароль входа на среду берётся из .local/test-1-access.txt, значения не печатаются.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const access = readFileSync('.local/test-1-access.txt', 'utf8');
const gate = access.match(/парол\S*\s+(\S+)/i)?.[1];
if (!gate) throw new Error('нет пароля входа на среду');
const SITE = 'https://test-1.5espace.com';
const basic = `Basic ${Buffer.from(`tester:${gate}`).toString('base64')}`;
const jar = new Map();
const call = async (method, path, body, cookies = jar) => {
  const r = await fetch(`${SITE}/v1${path}`, {
    method,
    redirect: 'manual',
    headers: {
      authorization: basic,
      origin: SITE,
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      ...(cookies.get('ul_csrf') ? { 'x-csrf-token': cookies.get('ul_csrf') } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const line of r.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  return { status: r.status, json, text };
};
const say = (name, value) => console.log(`${name}: ${value}`);
const code = (r) => `${r.status} ${r.json?.code ?? r.json?.error?.code ?? ''}`.trim();

const templates = await call('GET', '/auth/consents/templates');
const items = templates.json?.items ?? [];
say('документы условий', `${templates.status}, ${items.length}: ${items.map((t) => t.kind).join(' ')}`);
say('поля документа', Object.keys(items[0] ?? {}).join(' '));

const email = `probe-${randomBytes(4).toString('hex')}@example.invalid`;
const password = randomBytes(18).toString('base64url');
const required = items.filter((t) => t.required !== false && t.kind !== 'marketing_communications');
const consents = required.map((t) => ({ kind: t.kind, version: t.version, locale: t.locale }));
const reg = await call('POST', '/auth/register', {
  email,
  password,
  displayName: 'Проба сценария',
  role: 'founder',
  locale: 'ru-RU',
  consents,
});
say('регистрация с паролем и именем', code(reg));
if (reg.status >= 400) say('ответ', reg.text.slice(0, 300));
say('куки сразу после регистрации', [...jar.keys()].join(' ') || 'нет');
say('сессия', `статус ${reg.json?.status}, роли ${reg.json?.roles}`);

const me = await call('GET', '/auth/me');
say('кабинет без подтверждения почты: /auth/me', code(me));
const verify = await call('GET', '/auth/email/verify/status');
say('подтверждение почты', `${verify.status} ${verify.text.slice(0, 120)}`);

if (reg.json?.status !== 'active' && consents.length) {
  say('принятие условий', code(await call('POST', '/auth/consents', { consents })));
}
const taxonomy = await call('GET', '/taxonomy');
const taxonomyId = taxonomy.json?.items?.[0]?.id;
say('справочник отраслей', `${taxonomy.status}, ${taxonomy.json?.items?.length ?? 0}`);
const project = await call('POST', '/projects', {
  title: 'Проба сценария',
  stage: 'idea',
  taxonomyId: taxonomyId ?? '00000000-0000-7000-8000-000000000000',
  investmentAsk: '1000000',
  askCurrency: 'RUB',
});
say('создание проекта без подтверждения почты', code(project));
if (project.status >= 400) say('ответ', project.text.slice(0, 260));
if (project.json?.id) {
  const listing = await call('POST', `/projects/${project.json.id}/listing`, {});
  say('публикация без KYC', `${code(listing)} ${listing.text.slice(0, 160)}`);
}

const old = new Map(jar);
say('выход', code(await call('POST', '/auth/logout', {})));
say('старые куки после выхода', code(await call('GET', '/auth/me', undefined, old)));
