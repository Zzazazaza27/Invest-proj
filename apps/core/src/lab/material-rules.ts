import { MATERIAL_UPLOAD_RULES, type UploadableMaterialType } from '@unicorn/contracts';

/**
 * Лимиты и MIME — из контрактов (MATERIAL_UPLOAD_RULES): один источник правды
 * для DTO, сервера и интерфейсов (CODE-HIGH-09/CODE-MED-02).
 */
export const MAX_UPLOAD_BYTES: Record<UploadableMaterialType, number> = {
  deck: MATERIAL_UPLOAD_RULES.deck.maxBytes,
  video: MATERIAL_UPLOAD_RULES.video.maxBytes,
  doc: MATERIAL_UPLOAD_RULES.doc.maxBytes,
};

/**
 * Сигнатуры форматов по типу материала. Заявленный Content-Type — слово
 * клиента; подписанная форма фиксирует заголовок, но не содержимое
 * (SEC-HIGH-02). Первые байты объекта обязаны соответствовать одному из
 * форматов, допустимых для типа, иначе подтверждение отказывает.
 */
export const MATERIAL_SIGNATURES: Record<UploadableMaterialType, (head: Buffer) => boolean> = {
  // %PDF- либо контейнер OOXML (pptx — это zip: PK\x03\x04).
  deck: (head) => isPdf(head) || isZip(head),
  // ISO BMFF: 'ftyp' по смещению 4.
  video: (head) => head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp',
  // Скан или документ: pdf, png, jpeg.
  doc: (head) => isPdf(head) || isPng(head) || isJpeg(head),
};

/**
 * Причина отказа по формату — словами пользователя: какой материал и какие
 * форматы годятся. Внутреннее имя типа (`deck`) наружу не уходит.
 */
export const MATERIAL_FORMAT_REJECTIONS: Record<UploadableMaterialType, string> = {
  deck: 'Файл не похож на презентацию: подойдёт PDF или PPTX',
  video: 'Файл не похож на видео: подойдёт MP4',
  doc: 'Файл не похож на документ: подойдёт PDF, PNG или JPEG',
};

const isPdf = (head: Buffer) => head.subarray(0, 5).toString('latin1') === '%PDF-';
const isZip = (head: Buffer) => head.length >= 4 && head.readUInt32BE(0) === 0x504b0304;
const isPng = (head: Buffer) =>
  head.length >= 8 && head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
const isJpeg = (head: Buffer) =>
  head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;

/** Тип содержимого готового файла по проверенной сигнатуре, а не по слову клиента. */
export function detectMaterialContentType(head: Buffer): string | null {
  if (isPdf(head)) return 'application/pdf';
  if (isZip(head))
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (isPng(head)) return 'image/png';
  if (isJpeg(head)) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  return null;
}
