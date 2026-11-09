/**
 * Сведения для учёта удалений (2.1.5): по ним после восстановления старой копии итоговое
 * состояние объекта применяется заново (scripts/deletions-apply.mjs). Только ключи
 * объектов хранилища, их SHA-256 и свойства — без содержимого, имён файлов и секретов.
 */
import { createHash } from 'node:crypto';

export const sha256Hex = (body: Buffer | Uint8Array): string =>
  createHash('sha256').update(body).digest('hex');

export interface StoredImage {
  masterKey: string;
  masterSha256: string;
  variants: Record<string, { key: string; width: number; height: number; sha256: string }>;
  mime: string;
  bytes: number;
  width: number;
  height: number;
}
