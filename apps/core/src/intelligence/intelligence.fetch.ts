/**
 * Market Intelligence: разборщик get-investor.ru, чтение HTML и безопасная
 * загрузка страниц. Вынесено из сервиса, чтобы сервис держал только модель
 * (источник, сущность, упоминание), а не сетевые подробности.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { EntityType } from './intelligence.service';

// =================================================== get-investor: разбор

export interface GetInvestorCatalog {
  key: string;
  label: string;
  storePart: string;
  type: EntityType;
  /** Поле «Учредитель» в карточке — это организация, названная источником. */
  founderIsOrganization?: boolean;
  /** У мероприятия ссылка в тексте — страница регистрации, а не «Сайт:». */
  firstLinkIsWebsite?: boolean;
}

export const GET_INVESTOR_CATALOGS: readonly GetInvestorCatalog[] = [
  {
    key: 'investment-funds',
    label: 'Инвестиционные фонды',
    storePart: '808184690301',
    type: 'fund',
  },
  { key: 'business-angels', label: 'Бизнес-ангелы', storePart: '960638328541', type: 'investor' },
  {
    key: 'investor-clubs',
    label: 'Клубы инвесторов',
    storePart: '969184541201',
    type: 'investor_club',
  },
  {
    key: 'accelerators',
    label: 'Акселераторы',
    storePart: '631093317701',
    type: 'accelerator',
    founderIsOrganization: true,
  },
  {
    key: 'venture-studios',
    label: 'Венчурные студии',
    storePart: '186154586061',
    type: 'organization',
    founderIsOrganization: true,
  },
  {
    key: 'grants-and-subsidies',
    label: 'Гранты и субсидии',
    storePart: '494791447563',
    type: 'other',
  },
  {
    key: 'economic-zones',
    label: 'Особые экономические зоны',
    storePart: '556588871351',
    type: 'other',
  },
  {
    key: 'events-calendar',
    label: 'Календарь мероприятий',
    storePart: '710860811731',
    type: 'event',
    firstLinkIsWebsite: true,
  },
];

interface TildaProduct {
  uid: number | string;
  title: string;
  descr?: string;
  text?: string;
  url?: string;
  gallery?: string;
  characteristics?: { title: string; value: string }[];
}

export async function fetchTildaProducts(storePart: string): Promise<TildaProduct[]> {
  const all: TildaProduct[] = [];
  const size = 100;
  for (let slice = 1; slice <= 30; slice += 1) {
    const url =
      `https://store.tildaapi.com/api/getproductslist/?storepartuid=${storePart}` +
      `&getparts=false&getoptions=false&slice=${slice}&size=${size}`;
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, referer: 'https://get-investor.ru/' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`каталог ответил ${response.status}`);
    const body = (await response.json()) as { products?: TildaProduct[]; total?: number | string };
    const page = body.products ?? [];
    all.push(...page);
    const total = Number(body.total ?? 0);
    if (page.length === 0 || all.length >= total) break;
  }
  return all;
}

export function mapGetInvestorProduct(catalog: GetInvestorCatalog, product: TildaProduct) {
  const html = product.text ?? '';
  const plain = htmlToText(html);
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((m) => decodeEntities(m[1]!));

  const site = /Сайт[\s\S]{0,80}?<a[^>]+href="([^"]+)"/i.exec(html);
  const websiteUrl = catalog.firstLinkIsWebsite
    ? (hrefs.find((h) => /^https?:\/\//i.test(h)) ?? null)
    : site
      ? decodeEntities(site[1]!)
      : null;

  const characteristics: Record<string, string[]> = {};
  for (const c of product.characteristics ?? []) {
    (characteristics[c.title] ??= []).push(c.value);
  }

  const phone = /Телефон[^:\n]*:\s*([+\d][\d\s().-]{5,}\d)/i.exec(plain)?.[1]?.trim() ?? null;
  const founder = catalog.founderIsOrganization
    ? (/Учредитель\s*:\s*([^\n]+)/i.exec(plain)?.[1]?.trim() ?? null)
    : null;

  const image = firstImage(product.gallery);

  const attributes: Record<string, unknown> = {
    catalog: catalog.key,
    characteristics,
    text: plain,
  };
  if (phone) attributes.phone = phone;
  if (image) attributes.image = image;

  return {
    type: catalog.type,
    name: decodeEntities(product.title).trim().slice(0, 300),
    organizationName: founder ? founder.slice(0, 300) : null,
    description: product.descr ? htmlToText(product.descr).slice(0, 20000) || null : null,
    websiteUrl,
    email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(plain)?.[0] ?? null,
    telegram: hrefs.find((h) => /(?:t\.me|telegram\.me)\//i.test(h)) ?? null,
    linkedin: hrefs.find((h) => /linkedin\.com\//i.test(h)) ?? null,
    attributes,
    externalId: String(product.uid),
    externalUrl: product.url ?? `https://get-investor.ru/${catalog.key}#${product.uid}`,
  };
}

/** Первая картинка карточки: `gallery` — JSON строкой, и он бывает битым. */
function firstImage(gallery: string | undefined): string | null {
  try {
    return (JSON.parse(gallery ?? '[]') as { img?: string }[])[0]?.img ?? null;
  } catch {
    return null;
  }
}

// ================================================================ HTML

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    nbsp: ' ',
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    laquo: '«',
    raquo: '»',
    mdash: '—',
    ndash: '–',
    hellip: '…',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return named[code.toLowerCase()] ?? whole;
  });
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractTitle(html: string): string | null {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const value = decodeEntities((title ?? og ?? '').replace(/\s+/g, ' ')).trim();
  return value ? value.slice(0, 1000) : null;
}

// ======================================================= безопасная загрузка

const USER_AGENT = 'Mozilla/5.0 (compatible; FifthElementIntelligence/0.1)';

/**
 * Адреса, куда сервер не ходит по ссылке из формы: петля, частные сети,
 * служебные диапазоны облаков. Иначе «Импорт URL» стал бы способом
 * заглянуть изнутри в соседние службы стенда (база, брокер, метаданные).
 */
const FORBIDDEN = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
] as const) {
  FORBIDDEN.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['::ffff:0:0', 96],
] as const) {
  FORBIDDEN.addSubnet(net, prefix, 'ipv6');
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('допустимы только адреса http и https');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new Error('нестандартный порт не загружается');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  for (const { address, family } of addresses) {
    if (FORBIDDEN.check(address, family === 6 ? 'ipv6' : 'ipv4')) {
      throw new Error('адрес ведёт во внутреннюю сеть');
    }
  }
}

export async function safeFetchText(raw: string): Promise<string> {
  let url = new URL(raw);
  for (let hop = 0; hop < 4; hop += 1) {
    await assertPublicHost(url);
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*;q=0.5' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location')!, url);
      continue;
    }
    if (!response.ok) throw new Error(`сайт ответил ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    const limit = 3 * 1024 * 1024;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      chunks.push(value);
      if (size >= limit) {
        await reader.cancel();
        break;
      }
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
  }
  throw new Error('слишком много перенаправлений');
}
