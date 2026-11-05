import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AppError } from '../common/errors';
import { getEnv } from '../config/env';
import {
  isVaultFormat,
  LEGACY_KEY_VERSION,
  legacyToVault,
  parseVault,
  vaultToLegacy,
} from './key-format';
import { TransitClient } from './transit-client';

/**
 * Envelope encryption и blind index.
 *
 * Схема: на каждое значение генерируется свой DEK, значение шифруется
 * AES-256-GCM, а сам DEK шифруется ключом домена (KEK) и хранится рядом.
 * Компрометация одного DEK не раскрывает остальные записи; ротация KEK не
 * требует перешифровки данных — только перешифровки обёрток.
 *
 * KEK-домены соответствуют `audit.encryption_keys_registry`.
 *
 * Два независимых выбора (блок 5, задание 4):
 *  - `KMS_MODE` — где живёт ключ: в окружении (`local`) или в OpenBao Transit (`kms`);
 *  - `CRYPTO_WRITE_FORMAT` — как пишется запись: прежним форматом (`legacy`) или `vault:vN:`.
 *
 * Читаются оба формата. Переходный выпуск пишет `legacy` прежним ключом версии 1, поэтому записи
 * понимает и старое ядро. Граница возврата начинается с первой записи `vault`.
 */

export type KekDomain =
  'kyc_documents' | 'kyb_documents' | 'passport_sensitive' | 'search_index' | 'webhook_secrets';

const ENV_BY_DOMAIN: Record<KekDomain, string> = {
  kyc_documents: 'KEK_KYC_DOCUMENTS',
  kyb_documents: 'KEK_KYB_DOCUMENTS',
  passport_sensitive: 'KEK_PASSPORT_SENSITIVE',
  search_index: 'KEK_SEARCH_INDEX',
  webhook_secrets: 'KEK_WEBHOOK_SECRETS',
};

/** Имена ключей Transit заданы здесь и не приходят извне. */
const TRANSIT_KEY_BY_DOMAIN: Record<KekDomain, string> = {
  kyc_documents: 'kyc-documents',
  kyb_documents: 'kyb-documents',
  passport_sensitive: 'passport-sensitive',
  search_index: 'search-index',
  webhook_secrets: 'webhook-secrets',
};

const IV_BYTES = 12; // рекомендованный размер nonce для GCM
const TAG_BYTES = 16;
const DEK_BYTES = 32;

export interface SealedValue {
  /** iv || tag || ciphertext */
  ciphertext: Buffer;
  /** DEK, зашифрованный KEK домена: iv || tag || ciphertext */
  wrappedDek: Buffer;
}

/** Отказ службы ключей: это не порча данных, и скрывать его как «значения нет» нельзя. */
export function isKmsUnavailable(error: unknown): boolean {
  return error instanceof AppError && error.internal?.['dependency'] === 'kms';
}

@Injectable()
export class CryptoService {
  private transitClient: TransitClient | null = null;

  /** Шифрует значение и возвращает его вместе с обёрнутым DEK. */
  async seal(domain: KekDomain, plaintext: Buffer | string, aad?: string): Promise<SealedValue> {
    const dek = randomBytes(DEK_BYTES);
    try {
      const ciphertext = this.encrypt(dek, Buffer.from(plaintext), aad);
      const wrappedDek = await this.wrap(domain, dek, `wrap:${domain}`);
      return { ciphertext, wrappedDek };
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Шифрует НЕСКОЛЬКО значений одним DEK.
   *
   * Нужно там, где схема хранит один `wrapped_dek` на строку (например,
   * `identity.users`: email и телефон делят `contact_wrapped_dek`). Каждое
   * значение получает собственный AAD, поэтому шифртексты нельзя поменять
   * местами — расшифровка чужого поля не пройдёт проверку тега.
   */
  async sealMany<K extends string>(
    domain: KekDomain,
    values: Record<K, Buffer | string | null>,
  ): Promise<{ ciphertexts: Record<K, Buffer | null>; wrappedDek: Buffer }> {
    const dek = randomBytes(DEK_BYTES);
    try {
      const ciphertexts = {} as Record<K, Buffer | null>;
      for (const [field, value] of Object.entries(values) as [K, Buffer | string | null][]) {
        ciphertexts[field] =
          value === null || value === undefined
            ? null
            : this.encrypt(dek, Buffer.from(value), `field:${field}`);
      }
      return { ciphertexts, wrappedDek: await this.wrap(domain, dek, `wrap:${domain}`) };
    } finally {
      dek.fill(0);
    }
  }

  /** Расшифровка одного поля из группы, зашифрованной `sealMany`. */
  async openField(
    domain: KekDomain,
    wrappedDek: Buffer,
    ciphertext: Buffer,
    field: string,
  ): Promise<Buffer> {
    const opened = await this.openFields(domain, wrappedDek, { [field]: ciphertext });
    return opened[field]!;
  }

  /** Несколько полей одной строки: DEK распаковывается один раз, а не на каждое поле. */
  async openFields<K extends string>(
    domain: KekDomain,
    wrappedDek: Buffer,
    fields: Record<K, Buffer | null>,
  ): Promise<Record<K, Buffer | null>> {
    const dek = await this.unwrap(domain, wrappedDek, `wrap:${domain}`);
    try {
      const opened = {} as Record<K, Buffer | null>;
      for (const [field, ciphertext] of Object.entries(fields) as [K, Buffer | null][]) {
        opened[field] = ciphertext ? this.decrypt(dek, ciphertext, `field:${field}`) : null;
      }
      return opened;
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Шифрование КОРОТКОГО секрета напрямую ключом домена, без обёрнутого DEK.
   *
   * Схема с DEK существует ради двух вещей: шифровать много данных одним
   * ключом и менять KEK, не трогая шифртексты. Для 32-байтного секрета подписи
   * вебхука не нужно ни то, ни другое — а хранить рядом ещё и обёрнутый DEK
   * схема таблицы не предусматривает (`integration.webhook_endpoints` держит
   * один `secret_ciphertext`). Ротация KEK здесь означает перешифровку
   * нескольких строк, и это дешевле, чем размазывать формат по колонкам.
   *
   * Для документов и ПДн этот метод НЕ применяется: там объёмы и ротация как
   * раз те, ради которых нужен DEK.
   */
  sealDirect(domain: KekDomain, plaintext: Buffer | string, aad: string): Promise<Buffer> {
    return this.wrap(domain, Buffer.from(plaintext), aad);
  }

  openDirect(domain: KekDomain, payload: Buffer, aad: string): Promise<Buffer> {
    return this.unwrap(domain, payload, aad);
  }

  async open(domain: KekDomain, sealed: SealedValue, aad?: string): Promise<Buffer> {
    const dek = await this.unwrap(domain, sealed.wrappedDek, `wrap:${domain}`);
    try {
      return this.decrypt(dek, sealed.ciphertext, aad);
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Blind index: детерминированный HMAC для поиска по зашифрованному полю.
   *
   * Детерминированность — осознанный компромисс: она позволяет найти
   * пользователя по email, но делает возможной проверку «есть ли такой адрес»
   * при утечке ключа. Поэтому ключ живёт в отдельном KEK-домене и ротируется
   * отдельной процедурой.
   */
  blindIndex(value: string, kind: 'email' | 'phone' | 'inn'): Promise<Buffer> {
    return this.searchHmac(`${kind}:${this.normalize(value, kind)}`);
  }

  /** Сравнение секретов — только constant-time. */
  static equals(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Хеш IP и User-Agent для записи акцепта: сам адрес не сохраняется. */
  contextHash(value: string): Promise<Buffer> {
    return this.searchHmac(`ctx:${value}`);
  }

  /** Подпись ключа для столбца `*_kms_key_id`: версия новой записи живёт в её формате. */
  keyId(domain: KekDomain): string {
    const env = getEnv();
    if (env.CRYPTO_WRITE_FORMAT === 'legacy') return `local/${domain}/v${LEGACY_KEY_VERSION}`;
    return `transit/${this.transitKey(domain)}`;
  }

  /**
   * Нормализация до вычисления индекса: без неё `A@b.RU` и `a@b.ru` дадут
   * разные индексы и создадут два аккаунта на один адрес.
   */
  private normalize(value: string, kind: 'email' | 'phone' | 'inn'): string {
    const trimmed = value.trim();
    if (kind === 'email') return trimmed.toLowerCase();
    if (kind === 'phone') return trimmed.replace(/[^\d+]/g, '');
    return trimmed.replace(/\D/g, '');
  }

  private async searchHmac(input: string): Promise<Buffer> {
    const env = getEnv();
    if (env.KMS_MODE === 'local') {
      return createHmac('sha256', this.kek('search_index')).update(input, 'utf8').digest();
    }
    return this.transit().hmac(
      this.transitKey('search_index'),
      input,
      env.OPENBAO_SEARCH_INDEX_VERSION,
    );
  }

  /** Упаковка ключом домена. Формат записи выбирается отдельно от места хранения ключа. */
  private async wrap(domain: KekDomain, plaintext: Buffer, aad: string): Promise<Buffer> {
    const env = getEnv();
    if (env.KMS_MODE === 'local') {
      if (env.CRYPTO_WRITE_FORMAT !== 'legacy') {
        throw new Error('формат vault пишется только через Transit');
      }
      return this.encrypt(this.kek(domain), plaintext, aad);
    }
    const key = this.transitKey(domain);
    if (env.CRYPTO_WRITE_FORMAT === 'legacy') {
      const text = await this.transit().encrypt(key, plaintext, aad, LEGACY_KEY_VERSION);
      return vaultToLegacy(text);
    }
    const text = await this.transit().encrypt(key, plaintext, aad);
    parseVault(text);
    return Buffer.from(text, 'ascii');
  }

  private async unwrap(domain: KekDomain, payload: Buffer, aad: string): Promise<Buffer> {
    const local = getEnv().KMS_MODE === 'local';
    if (isVaultFormat(payload)) {
      const text = payload.toString('ascii');
      parseVault(text);
      if (local) throw new Error('запись формата vault не читается местными ключами');
      return this.transit().decrypt(this.transitKey(domain), text, aad);
    }
    if (local) return this.decrypt(this.kek(domain), payload, aad);
    return this.transit().decrypt(this.transitKey(domain), legacyToVault(payload), aad);
  }

  private transitKey(domain: KekDomain): string {
    return `${getEnv().OPENBAO_KEY_PREFIX}-${TRANSIT_KEY_BY_DOMAIN[domain]}`;
  }

  private transit(): TransitClient {
    const env = getEnv();
    this.transitClient ??= new TransitClient({
      addr: env.OPENBAO_ADDR,
      caFile: env.OPENBAO_CA_PATH,
      tokenFile: env.OPENBAO_TOKEN_PATH,
      timeoutMs: env.OPENBAO_TIMEOUT_MS,
    });
    return this.transitClient;
  }

  private kek(domain: KekDomain): Buffer {
    const raw = process.env[ENV_BY_DOMAIN[domain]] ?? '';
    const key = Buffer.from(raw, 'base64');
    if (key.length !== DEK_BYTES) {
      throw new Error(`KEK домена ${domain} не задан или имеет неверную длину`);
    }
    return key;
  }

  private encrypt(key: Buffer, plaintext: Buffer, aad?: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    // authTagLength задаётся явно: без него значение берётся по умолчанию, и
    // усечённый тег (до 4 байт) прошёл бы проверку, ослабив аутентичность.
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  private decrypt(key: Buffer, payload: Buffer, aad?: string): Buffer {
    if (payload.length < IV_BYTES + TAG_BYTES) {
      throw new Error('повреждённые данные: недостаточная длина');
    }
    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = payload.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }
}
