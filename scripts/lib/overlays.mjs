import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Дополнения Compose — часть конфигурации сборки (Тэнк 11.11, работа № 1 раздела 01). Среда
 * работает со сверенной копией дополнений своей сборки в своём каталоге, а не с файлами серверной
 * копии репозитория: синхронизация инструментов не меняет конфигурацию ни одной среды.
 *
 * Источник для сборки:
 *  - комплект с полем `overlays` — файлы `overlays/` комплекта, суммы в подписанном манифесте;
 *  - комплект без поля (выпущен раньше) — закреплённая история `infra/kit-history/<сборка>/`:
 *    копии файлов на коммите сборки, происхождение проверяет `scripts/kit-history.mjs check`;
 *  - метка без комплекта (разработка) — рабочая копия.
 * Секреты и изменяемые параметры среды (.env, compose.env, settings.env, флаги режимов) сюда не
 * входят. Общие Caddy и OpenBao — тоже.
 */
export const OVERLAYS = {
  production: 'infra/docker-compose.env-production.yml',
  slots: 'infra/docker-compose.env-slots.yml',
  journald: 'infra/docker-compose.env-journald.yml',
  secrets: 'infra/docker-compose.secrets.yml',
  tls: 'infra/docker-compose.tls.yml',
  'prod-slots': 'infra/docker-compose.slots.yml',
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Суммы дополнений рабочей копии — для манифеста нового комплекта. */
export function overlayManifest(root) {
  return Object.fromEntries(
    Object.values(OVERLAYS)
      .filter((p) => existsSync(join(root, p)))
      .map((p) => [p, sha256(readFileSync(join(root, p)))]),
  );
}

/**
 * Источник дополнений сборки. Ошибка — до любых изменений среды: у выпущенной сборки нет ни
 * поля в манифесте, ни закреплённой истории, либо история от другого коммита.
 */
export function overlaySource({ kitsDir, historyDir, root, label }) {
  const kitFile = join(kitsDir, label, 'kit.json');
  if (!existsSync(kitFile)) {
    return { origin: 'repo', label, sums: overlayManifest(root), at: (p) => join(root, p) };
  }
  const kit = JSON.parse(readFileSync(kitFile, 'utf8'));
  if (kit.overlays) {
    const dir = join(kitsDir, label, 'overlays');
    return { origin: 'kit', label, sums: kit.overlays, at: (p) => join(dir, basename(p)) };
  }
  const manifestFile = join(historyDir, label, 'manifest.json');
  if (!existsSync(manifestFile)) {
    throw new Error(`сборка ${label}: в комплекте нет дополнений и нет закреплённой истории`);
  }
  const history = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (history.build !== label || history.commit !== kit.commit) {
    throw new Error(`сборка ${label}: закреплённая история не от коммита комплекта`);
  }
  const dir = join(historyDir, label);
  return { origin: 'history', label, sums: history.files, at: (p) => join(dir, basename(p)) };
}

/** Есть ли дополнение в источнике. */
export const hasOverlay = (src, name) => Boolean(src.sums[OVERLAYS[name]]);

/** Сверка выбранных дополнений источника: список проблем. */
export function overlayProblems(src, names) {
  const problems = [];
  for (const name of names) {
    const path = OVERLAYS[name];
    if (!src.sums[path]) continue;
    const file = src.at(path);
    if (!existsSync(file)) problems.push(`${path}: нет в источнике ${src.origin}`);
    else if (sha256(readFileSync(file)) !== src.sums[path])
      problems.push(`${path}: хеш не сошёлся (${src.origin})`);
  }
  return problems;
}

/**
 * Сделать дополнения сборки действующими в каталоге среды: прежние копии убираются, выбранные
 * сверенные — копируются. Отказ сверки — до изменений каталога.
 */
export function activateOverlays(src, names, destDir) {
  const problems = overlayProblems(src, names);
  if (problems.length) throw new Error(problems.join('; '));
  mkdirSync(destDir, { recursive: true });
  for (const f of readdirSync(destDir)) if (f.endsWith('.yml')) rmSync(join(destDir, f));
  const active = [];
  for (const name of names) {
    const path = OVERLAYS[name];
    if (!src.sums[path]) continue;
    copyFileSync(src.at(path), join(destDir, basename(path)));
    active.push(name);
  }
  return active;
}

/** Путь действующей копии дополнения в каталоге среды. */
export const activeOverlay = (destDir, name) => join(destDir, basename(OVERLAYS[name]));
