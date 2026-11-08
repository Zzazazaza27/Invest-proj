import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/client';
import { keyAfterError, keyAfterSuccess, keyForSend } from '../src/retry-key';

/** Удержание ключа повтора (2.6), замечание Тэнка к 094c8ad. */
const lost = new ApiError('нет ответа', {
  code: 'dependency_unavailable',
  status: 502,
  outcomeUnknown: true,
});
const inProgress = new ApiError('выполняется', { code: 'operation_in_progress', status: 409 });
const unavailable = new ApiError('недоступно', { code: 'dependency_unavailable', status: 503 });
const validation = new ApiError('поля', { code: 'validation_failed', status: 400 });

describe('Ключ повтора держится до подтверждённого завершения', () => {
  it('потерянный ответ → «выполняется» → временный отказ → успех: везде один ключ', () => {
    const sent: string[] = [];
    let k = keyForSend(null);
    sent.push(k.key);
    k = keyAfterError(k, lost)!;
    k = keyForSend(k);
    sent.push(k.key);
    k = keyAfterError(k, inProgress)!;
    k = keyForSend(k);
    sent.push(k.key);
    k = keyAfterError(k, unavailable)!;
    k = keyForSend(k);
    sent.push(k.key);
    expect(new Set(sent).size).toBe(1);
    expect(keyAfterSuccess()).toBeNull();
  });

  it('после неизвестного исхода даже окончательный отказ ключа не снимает', () => {
    const k = keyAfterError(keyForSend(null), lost)!;
    expect(keyAfterError(k, validation)).toEqual({ key: k.key, unresolved: true });
  });

  it('окончательный отказ первой отправки (ничего не записано) — ключ снимается', () => {
    expect(keyAfterError(keyForSend(null), validation)).toBeNull();
  });

  it('промежуточный отказ сам по себе исход не разрешает', () => {
    const k = keyForSend(null);
    for (const e of [inProgress, unavailable, new TypeError('fetch failed')]) {
      expect(keyAfterError(k, e)?.key).toBe(k.key);
    }
  });
});
