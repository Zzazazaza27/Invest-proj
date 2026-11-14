/**
 * Архив образов прямо из реестра по дайджесту (общая приёмка 4б, 14.11).
 *
 * Почему не `docker save`: на узле Docker 29 с хранилищем containerd. При скачивании образа он
 * не загружает блоки слоёв, уже распакованных у прежних версий, и `docker save` такую
 * платформу считает недоступной — молча пишет архив из одних описей (образ ядра: 16 КБ вместо
 * ~110 МБ). Так были неполны и комплекты выпуска, и копии узла.
 *
 * Здесь каждый блок берётся из реестра и сверяется с дайджестом: индекс, все манифесты, config
 * и слои. Результат — каталог OCI (oci-layout, index.json, blobs/sha256) с метками
 * `io.containerd.image.name` — `docker load` ставит по ним теги. Учётные данные — из
 * $DOCKER_CONFIG/config.json (после `docker login`), в аргументы процессов не попадают.
 */
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** `ghcr.io/owner/repo/name@sha256:…` → части. */
export function parseRef(ref) {
  const m = /^([^/]+)\/(.+)@(sha256:[0-9a-f]{64})$/.exec(ref);
  if (!m) throw new Error(`ссылка на образ не по дайджесту: ${ref}`);
  return { host: m[1], repo: m[2], digest: m[3] };
}

function basicAuth(host) {
  const dir = process.env.DOCKER_CONFIG || join(homedir(), '.docker');
  const file = join(dir, 'config.json');
  if (!existsSync(file)) return null;
  const auths = JSON.parse(readFileSync(file, 'utf8')).auths ?? {};
  return auths[host]?.auth ?? auths[`https://${host}`]?.auth ?? null;
}

async function bearer(host, repo) {
  const auth = basicAuth(host);
  const r = await fetch(`https://${host}/token?scope=repository:${repo}:pull&service=${host}`, {
    headers: auth ? { Authorization: `Basic ${auth}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`реестр ${host}: токен не выдан (HTTP ${r.status})`);
  return (await r.json()).token;
}

/**
 * Собрать каталог OCI для образов `refs` ({ ref, name }) в `dir`. Возвращает список блоков.
 * Каждый блок сверяется с дайджестом; несошедшийся — ошибка.
 */
export async function registryArchive(images, dir) {
  mkdirSync(join(dir, 'blobs', 'sha256'), { recursive: true });
  const tokens = new Map();
  const index = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [],
  };
  const have = new Set();
  // manifest.json формата docker-archive: классическое хранилище Docker без него не загружает.
  const legacy = [];
  for (const { ref, name } of images) {
    const { host, repo, digest } = parseRef(ref);
    const key = `${host}/${repo}`;
    if (!tokens.has(key)) tokens.set(key, await bearer(host, repo));
    const headers = { Authorization: `Bearer ${tokens.get(key)}` };
    const blobPath = (d) => join(dir, 'blobs', 'sha256', d.replace(/^sha256:/, ''));

    const getManifest = async (d) => {
      const r = await fetch(`https://${host}/v2/${repo}/manifests/${d}`, {
        headers: { ...headers, Accept: ACCEPT },
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`манифест ${d.slice(0, 19)}: HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const got = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
      if (got !== d) throw new Error(`манифест ${d.slice(0, 19)}: дайджест не сошёлся`);
      writeFileSync(blobPath(d), buf);
      have.add(d);
      return {
        json: JSON.parse(buf.toString('utf8')),
        mediaType: r.headers.get('content-type'),
        size: buf.length,
      };
    };
    const getBlob = async (d) => {
      if (have.has(d) || existsSync(blobPath(d))) return have.add(d);
      const r = await fetch(`https://${host}/v2/${repo}/blobs/${d}`, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(600_000),
      });
      if (!r.ok) throw new Error(`блок ${d.slice(0, 19)}: HTTP ${r.status}`);
      const tmp = `${blobPath(d)}.part`;
      const h = createHash('sha256');
      const body = Readable.fromWeb(r.body);
      body.on('data', (c) => h.update(c));
      await pipeline(body, createWriteStream(tmp));
      if (`sha256:${h.digest('hex')}` !== d)
        throw new Error(`блок ${d.slice(0, 19)}: дайджест не сошёлся`);
      renameSync(tmp, blobPath(d));
      have.add(d);
    };
    let platformManifest = null;
    const walk = async (d, platform = null) => {
      const m = await getManifest(d);
      if (Array.isArray(m.json.manifests)) {
        for (const sub of m.json.manifests) await walk(sub.digest, sub.platform ?? null);
      } else {
        await getBlob(m.json.config.digest);
        for (const l of m.json.layers ?? []) await getBlob(l.digest);
        const amd64 = !platform || (platform.os === 'linux' && platform.architecture === 'amd64');
        if (amd64 && !platformManifest) platformManifest = m.json;
      }
      return m;
    };
    const top = await walk(digest);
    if (!platformManifest) throw new Error(`${ref}: нет манифеста linux/amd64`);
    const b = (d) => `blobs/sha256/${d.replace(/^sha256:/, '')}`;
    legacy.push({
      Config: b(platformManifest.config.digest),
      RepoTags: [name],
      Layers: (platformManifest.layers ?? []).map((l) => b(l.digest)),
    });
    index.manifests.push({
      mediaType: top.json.mediaType ?? top.mediaType,
      digest,
      size: top.size,
      annotations: {
        'io.containerd.image.name': `docker.io/${name}`,
        'org.opencontainers.image.ref.name': name.split(':').pop(),
      },
    });
  }
  writeFileSync(join(dir, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(legacy));
  return [...have];
}
