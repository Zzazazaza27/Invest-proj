import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { getEnv } from '../config/env';

/**
 * Envelope encryption и blind index.
 *
 * Схема: на каждое значение генерируется свой DEK, значение шифруется
 * AES-256-GCM, а сам DEK шифруется ключом домена (KEK) и хранится рядом.
 * Компрометация одного DEK не раскрывает остальные записи; ротация KEK не
 * требует перешифровки данных — только перешифровки обёрток.
 *
 * KEK-домены соответствуют `audit.encryption_keys_registry`.
 */

export type KekDomain =
  | 'kyc_documents'
  | 'kyb_documents'
  | 'passport_sensitive'
  | 'investment_documents'
  | 'nominal_account_evidence'
  | 'billing_documents'
  | 'search_index'
  | 'webhook_secrets'
  // Ключи LLM-провайдеров, заданные из панели (ADR-008 §2). Свой домен, а не
  // webhook_secrets: компрометация или ротация ключа провайдера не должна
  // затрагивать подписи вебхуков, и наоборот.
  | 'ai_provider_secrets';

const ENV_BY_DOMAIN: Record<KekDomain, string> = {
  kyc_documents: 'KEK_KYC_DOCUMENTS',
  kyb_documents: 'KEK_KYB_DOCUMENTS',
  passport_sensitive: 'KEK_PASSPORT_SENSITIVE',
  investment_documents: 'KEK_INVESTMENT_DOCUMENTS',
  nominal_account_evidence: 'KEK_NOMINAL_ACCOUNT_EVIDENCE',
  billing_documents: 'KEK_BILLING_DOCUMENTS',
  search_index: 'KEK_SEARCH_INDEX',
  webhook_secrets: 'KEK_WEBHOOK_SECRETS',
  ai_provider_secrets: 'KEK_AI_PROVIDER_SECRETS',
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

@Injectable()
export class CryptoService {
  /** Шифрует значение и возвращает его вместе с обёрнутым DEK. */
  seal(domain: KekDomain, plaintext: Buffer | string, aad?: string): SealedValue {
    const dek = randomBytes(DEK_BYTES);
    const ciphertext = this.encrypt(dek, Buffer.from(plaintext), aad);
    const wrappedDek = this.encrypt(this.kek(domain), dek, `wrap:${domain}`);
    dek.fill(0);
    return { ciphertext, wrappedDek };
  }

  /**
   * Шифрует НЕСКОЛЬКО значений одним DEK.
   *
   * Нужно там, где схема хранит один `wrapped_dek` на строку (например,
   * `identity.users`: email и телефон делят `contact_wrapped_dek`). Каждое
   * значение получает собственный AAD, поэтому шифртексты нельзя поменять
   * местами — расшифровка чужого поля не пройдёт проверку тега.
   */
  sealMany<K extends string>(
    domain: KekDomain,
    values: Record<K, Buffer | string | null>,
  ): { ciphertexts: Record<K, Buffer | null>; wrappedDek: Buffer } {
    const dek = randomBytes(DEK_BYTES);
    try {
      const ciphertexts = {} as Record<K, Buffer | null>;
      for (const [field, value] of Object.entries(values) as [K, Buffer | string | null][]) {
        ciphertexts[field] =
          value === null || value === undefined
            ? null
            : this.encrypt(dek, Buffer.from(value), `field:${field}`);
      }
      return { ciphertexts, wrappedDek: this.encrypt(this.kek(domain), dek, `wrap:${domain}`) };
    } finally {
      dek.fill(0);
    }
  }

  /** Расшифровка одного поля из группы, зашифрованной `sealMany`. */
  openField(domain: KekDomain, wrappedDek: Buffer, ciphertext: Buffer, field: string): Buffer {
    const dek = this.decrypt(this.kek(domain), wrappedDek, `wrap:${domain}`);
    try {
      return this.decrypt(dek, ciphertext, `field:${field}`);
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
  sealDirect(domain: KekDomain, plaintext: Buffer | string, aad: string): Buffer {
    return this.encrypt(this.kek(domain), Buffer.from(plaintext), aad);
  }

  openDirect(domain: KekDomain, payload: Buffer, aad: string): Buffer {
    return this.decrypt(this.kek(domain), payload, aad);
  }

  open(domain: KekDomain, sealed: SealedValue, aad?: string): Buffer {
    const dek = this.decrypt(this.kek(domain), sealed.wrappedDek, `wrap:${domain}`);
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
  blindIndex(value: string, kind: 'email' | 'phone' | 'inn'): Buffer {
    const normalized = this.normalize(value, kind);
    return createHmac('sha256', this.kek('search_index'))
      .update(`${kind}:${normalized}`, 'utf8')
      .digest();
  }

  /** Сравнение секретов — только constant-time. */
  static equals(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Хеш IP и User-Agent для записи акцепта: сам адрес не сохраняется. */
  contextHash(value: string): Buffer {
    return createHmac('sha256', this.kek('search_index')).update(`ctx:${value}`, 'utf8').digest();
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

  private kek(domain: KekDomain): Buffer {
    const env = getEnv();
    if (env.KMS_MODE !== 'local') {
      // Ветка внешнего KMS подключается вместе с production-инфраструктурой.
      // Молча падать на локальный ключ здесь нельзя: это тихое понижение
      // уровня защиты.
      throw new Error('KMS_MODE=kms требует настроенного клиента KMS (см. TODO)');
    }
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
