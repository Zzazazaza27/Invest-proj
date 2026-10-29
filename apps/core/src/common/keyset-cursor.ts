import { errors } from './errors';

/**
 * Keyset-курсор (at, id) для постраничных выдач: base64url от JSON. Повреждённый
 * курсор — ошибка проверки ввода, а не 500.
 */
export function encodeIntegrationCursor(payload: { at: string; id: string }): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeIntegrationCursor(raw: string): { at: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw errors.validation([{ path: 'cursor', message: 'повреждённый курсор' }]);
  }
  const value = parsed as Partial<{ at: string; id: string }>;
  if (
    typeof value?.at !== 'string' ||
    typeof value?.id !== 'string' ||
    Number.isNaN(Date.parse(value.at)) ||
    !/^[0-9a-f-]{36}$/i.test(value.id)
  ) {
    throw errors.validation([{ path: 'cursor', message: 'повреждённый курсор' }]);
  }
  return { at: value.at, id: value.id };
}
