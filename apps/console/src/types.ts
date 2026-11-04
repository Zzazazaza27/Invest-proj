import type { FifthApi } from '@fifth/api-client';

/**
 * Описание операции API в терминах формы.
 *
 * Консоль не рисует отдельный экран под каждую из ~60 операций: экран один, а
 * операции — данные. Иначе покрытие всего API превратилось бы в шестьдесят
 * почти одинаковых страниц, которые расходятся с клиентом по одной за раз.
 */

export type FieldKind =
  'text' | 'password' | 'number' | 'select' | 'textarea' | 'checkbox' | 'json' | 'file';

export interface FieldOption {
  value: string;
  label: string;
}

export interface OperationField {
  /** Имя поля. Совпадает с именем в контракте — по нему же работает блокнот. */
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  options?: FieldOption[];
  placeholder?: string;
  /** Подсказка под полем: ограничение контракта, формат, смысл. */
  help?: string;
  defaultValue?: string | number | boolean;
}

/**
 * Значения формы.
 *
 * `File` здесь не ради красоты: подтверждение загрузки материала сервер
 * проверяет НАЛИЧИЕМ ОБЪЕКТА в хранилище — «я загрузил» от клиента
 * доказательством не считается. Значит консоль обязана уметь реально положить
 * файл по выданному билету, иначе сквозной сценарий материалов обрывается.
 */
export type FormValues = Record<string, string | number | boolean | File | undefined>;

/**
 * Блокнот сквозного прогона.
 *
 * Сценарий «создать проект → приложить материал → подать → выпустить оффер →
 * подписать» состоит из вызовов, каждый из которых принимает идентификатор,
 * полученный предыдущим. Переписывать UUID руками между формами — источник
 * опечаток и главная причина, по которой сквозной прогон бросают на середине.
 * Поэтому идентификаторы запоминаются автоматически и подставляются в поля с
 * тем же именем.
 */
export interface Notebook {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  entries(): [string, string][];
  clear(): void;
}

export interface RunContext {
  api: FifthApi;
  notebook: Notebook;
  /** Перечитать текущего пользователя (после входа, выхода, выдачи роли). */
  refreshSession: () => Promise<void>;
  /** Записать свежий CSRF-токен, пришедший в теле ответа на вход. */
  setCsrf: (token: string | null) => void;
}

export interface Operation {
  id: string;
  title: string;
  /** Метод и путь — для показа рядом с названием, не для отправки. */
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  /** Что делает операция и что именно ею проверяется. */
  summary: string;
  fields?: OperationField[];
  /** Требуется вход. Операция не блокируется — но предупреждение видно заранее. */
  needsAuth?: boolean;
  /**
   * Какие идентификаторы забрать из ответа в блокнот.
   * Ключ — имя в блокноте, значение — путь в ответе (`id`, `items.0.id`).
   */
  remembers?: Record<string, string>;
  run: (values: FormValues, ctx: RunContext) => Promise<unknown>;
}

export interface OperationGroup {
  id: string;
  title: string;
  /** Роль или условие, при котором группа осмысленна. */
  note?: string;
  operations: Operation[];
}
