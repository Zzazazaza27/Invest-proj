import { isIP } from 'node:net';

/**
 * Классификация IP-адреса: глобальный он или нет.
 *
 * Почему не сравнение строковых префиксов. Прежняя реализация проверяла
 * `startsWith('fe80')` и потому пропускала `fe90::1` и `febf::1`, хотя вся
 * link-local сеть — это `fe80::/10`, то есть первые ДЕСЯТЬ бит. Она же
 * пропускала `::ffff:7f00:1` — ту же петлю, записанную в шестнадцатеричном
 * виде вместо точечного, — и не знала про multicast `224.0.0.0/4` и
 * benchmark-сеть `198.18.0.0/15`. Внешний аудит воспроизвёл все пять обходов.
 *
 * Здесь адрес приводится к КАНОНИЧЕСКИМ БАЙТАМ и сравнивается с диапазонами по
 * длине префикса. Форма записи перестаёт иметь значение: сокращённая,
 * развёрнутая, с ведущими нулями, IPv4-mapped, NAT64 или 6to4 — всё сводится к
 * одному и тому же числу.
 *
 * Список диапазонов — из реестров специального назначения IANA (RFC 6890 и
 * последующие). Он намеренно шире «локалхоста»: адрес метаданных облака выдаёт
 * временные учётные данные роли инстанса, и это самый дорогой исход SSRF.
 */

/** Диапазон: первые `bits` бит адреса должны совпасть с `prefix`. */
interface Range {
  prefix: Uint8Array;
  bits: number;
  reason: string;
}

function v4(a: number, b: number, c: number, d: number, bits: number, reason: string): Range {
  return { prefix: Uint8Array.from([a, b, c, d]), bits, reason };
}

/** Не-глобальные диапазоны IPv4. */
const V4_RANGES: readonly Range[] = [
  v4(0, 0, 0, 0, 8, 'this-network'),
  v4(10, 0, 0, 0, 8, 'private'),
  v4(100, 64, 0, 0, 10, 'CGNAT'),
  v4(127, 0, 0, 0, 8, 'loopback'),
  v4(169, 254, 0, 0, 16, 'link-local и метаданные облака'),
  v4(172, 16, 0, 0, 12, 'private'),
  v4(192, 0, 0, 0, 24, 'IETF protocol assignments'),
  v4(192, 0, 2, 0, 24, 'documentation TEST-NET-1'),
  v4(192, 88, 99, 0, 24, '6to4 relay anycast'),
  v4(192, 168, 0, 0, 16, 'private'),
  v4(198, 18, 0, 0, 15, 'benchmarking'),
  v4(198, 51, 100, 0, 24, 'documentation TEST-NET-2'),
  v4(203, 0, 113, 0, 24, 'documentation TEST-NET-3'),
  v4(224, 0, 0, 0, 4, 'multicast'),
  v4(240, 0, 0, 0, 4, 'reserved и broadcast'),
];

function v6(prefixHex: string, bits: number, reason: string): Range {
  const bytes = new Uint8Array(16);
  const clean = prefixHex.replace(/:/g, '');
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return { prefix: bytes, bits, reason };
}

/**
 * Не-глобальные диапазоны IPv6.
 *
 * `::ffff:0:0/96` (IPv4-mapped), `64:ff9b::/96` (NAT64) и `2002::/16` (6to4)
 * здесь НЕ перечислены: они не запрещены сами по себе, но содержат внутри
 * адрес IPv4, который надо проверить отдельно. Это делается ниже извлечением
 * встроенной четвёрки — иначе `::ffff:7f00:1` прошёл бы как «обычный IPv6».
 */
const V6_RANGES: readonly Range[] = [
  v6('00000000000000000000000000000000', 128, 'unspecified'),
  v6('00000000000000000000000000000001', 128, 'loopback'),
  v6('fc00', 7, 'unique local'),
  v6('fe80', 10, 'link-local'),
  v6('ff00', 8, 'multicast'),
  v6('0100', 64, 'discard-only'),
  v6('20010db8', 32, 'documentation'),
  v6('20010000', 32, 'Teredo'),
  // Дополнение по текущему реестру IANA IPv6 Special-Purpose (SEC-MED-01):
  // диапазоны с Globally Reachable = False, которых не было в первоначальном
  // списке. Ручной denylist дрейфует от реестра — снимок сверен 2026-08-13,
  // источник: iana-ipv6-special-registry.
  v6('0064ff9b0001', 48, 'local-use IPv4/IPv6 translation (64:ff9b:1::/48)'),
  v6('0100000000000001', 64, 'dummy prefix (100:0:0:1::/64)'),
  v6('20010002', 48, 'benchmarking (2001:2::/48)'),
  v6('3fff', 20, 'documentation (3fff::/20)'),
  v6('5f00', 16, 'SRv6 SIDs (5f00::/16)'),
];

function matches(bytes: Uint8Array, range: Range): boolean {
  const fullBytes = range.bits >> 3;
  for (let i = 0; i < fullBytes; i += 1) {
    if (bytes[i] !== range.prefix[i]) return false;
  }
  const restBits = range.bits & 7;
  if (restBits === 0) return true;
  const mask = 0xff << (8 - restBits);
  return (bytes[fullBytes]! & mask) === (range.prefix[fullBytes]! & mask);
}

/** Байты IPv4-адреса. `null` — адрес не разобрался. */
function v4Bytes(address: string): Uint8Array | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    // Строгий разбор: `01` и `0x7f` разными библиотеками читаются по-разному,
    // и такая неоднозначность — сама по себе способ обхода.
    if (!/^\d{1,3}$/.test(parts[i]!)) return null;
    const value = Number(parts[i]);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

/** Развернуть IPv6 в 16 байт. `null` — адрес не разобрался. */
function v6Bytes(address: string): Uint8Array | null {
  let text = address.toLowerCase();
  const zoneAt = text.indexOf('%');
  // Идентификатор зоны (`fe80::1%eth0`) к адресу не относится.
  if (zoneAt >= 0) text = text.slice(0, zoneAt);

  // Хвост в точечной записи: `::ffff:127.0.0.1`, `64:ff9b::192.0.2.1`.
  let tail: Uint8Array | null = null;
  const dotted = text.lastIndexOf(':');
  if (dotted >= 0 && text.slice(dotted + 1).includes('.')) {
    tail = v4Bytes(text.slice(dotted + 1));
    if (!tail) return null;
    text = text.slice(0, dotted + 1) + '0:0';
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (groups < 0) return null;
  const all = [...head, ...Array.from({ length: groups }, () => '0'), ...rest];
  if (all.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(all[i]!)) return null;
    const value = Number.parseInt(all[i]!, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  if (tail) bytes.set(tail, 12);
  return bytes;
}

/**
 * Адрес IPv4, встроенный в IPv6.
 *
 * Возвращает четвёрку для IPv4-mapped (`::ffff:a.b.c.d`), NAT64
 * (`64:ff9b::a.b.c.d`) и 6to4 (`2002:AABB:CCDD::`). Во всех трёх случаях
 * запрет должен считаться по встроенному адресу: иначе петля, записанная как
 * `::ffff:7f00:1`, проходит проверку.
 */
function embeddedV4(bytes: Uint8Array): Uint8Array | null {
  const isMapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isMapped) return bytes.slice(12, 16);

  const isNat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0);
  if (isNat64) return bytes.slice(12, 16);

  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6);
  return null;
}

/**
 * Запрещён ли адрес для исходящей доставки.
 *
 * Неразобранный адрес считается запрещённым: «не смогли классифицировать» —
 * это не «можно».
 */
export function isForbiddenAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const bytes = v4Bytes(address);
    if (!bytes) return true;
    return V4_RANGES.some((range) => matches(bytes, range));
  }

  if (version === 6) {
    const bytes = v6Bytes(address);
    if (!bytes) return true;
    const embedded = embeddedV4(bytes);
    if (embedded && V4_RANGES.some((range) => matches(embedded, range))) return true;
    return V6_RANGES.some((range) => matches(bytes, range));
  }

  return true;
}

/** Причина запрета — для сообщений об ошибке и разбора инцидентов. */
export function forbiddenReason(address: string): string | null {
  const version = isIP(address);
  if (version === 4) {
    const bytes = v4Bytes(address);
    if (!bytes) return 'адрес не разобран';
    return V4_RANGES.find((range) => matches(bytes, range))?.reason ?? null;
  }
  if (version === 6) {
    const bytes = v6Bytes(address);
    if (!bytes) return 'адрес не разобран';
    const embedded = embeddedV4(bytes);
    const viaEmbedded = embedded
      ? V4_RANGES.find((range) => matches(embedded, range))?.reason
      : undefined;
    if (viaEmbedded) return `встроенный IPv4: ${viaEmbedded}`;
    return V6_RANGES.find((range) => matches(bytes, range))?.reason ?? null;
  }
  return 'не является IP-адресом';
}

/**
 * Принадлежит ли адрес одному из CIDR-диапазонов.
 *
 * Нужен привязке mTLS-заголовка к доверенному прокси (SEC-CRIT-03): заголовок
 * с отпечатком сертификата можно принимать только от пира из
 * `TRUSTED_PROXY_CIDRS` — иначе клиент, дотянувшийся до ядра напрямую, впишет
 * отпечаток сам. Сравнение — теми же каноническими байтами, что и денилист:
 * `::ffff:10.0.0.5` и `10.0.0.5` — один адрес в двух записях.
 */
export function addressInCidrs(address: string, cidrs: readonly string[]): boolean {
  const addrBytes = canonical16(address);
  if (!addrBytes) return false;
  for (const entry of cidrs) {
    const [prefixText, bitsText] = entry.split('/');
    if (!prefixText) continue;
    const prefixBytes = canonical16(prefixText.trim());
    if (!prefixBytes) continue;
    const isV4 = isIP(prefixText.trim()) === 4;
    const declared = bitsText === undefined ? (isV4 ? 32 : 128) : Number(bitsText);
    if (!Number.isInteger(declared) || declared < 0) continue;
    // IPv4-CIDR в 16-байтовом виде смещается на 96 бит mapped-префикса.
    const bits = isV4 ? Math.min(declared, 32) + 96 : Math.min(declared, 128);
    if (matches(addrBytes, { prefix: prefixBytes, bits, reason: entry })) return true;
  }
  return false;
}

/** Канонические 16 байт: IPv4 приводится к ::ffff:a.b.c.d. */
function canonical16(address: string): Uint8Array | null {
  const version = isIP(address);
  if (version === 4) {
    const four = v4Bytes(address);
    if (!four) return null;
    const bytes = new Uint8Array(16);
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    bytes.set(four, 12);
    return bytes;
  }
  if (version === 6) {
    const bytes = v6Bytes(address);
    if (!bytes) return null;
    // mapped-IPv4 уже в этой форме; NAT64/6to4 здесь не разворачиваются —
    // прокси задаётся оператором, а не приходит из недоверенной сети.
    return bytes;
  }
  return null;
}
