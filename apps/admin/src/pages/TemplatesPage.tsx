import { useCallback, useEffect, useState } from 'react';
import type { NotificationTemplate } from '@unicorn/contracts';
import { api } from '../api';
import { problemText } from '../lib/format';

const CHANNELS = ['push', 'telegram', 'email', 'sms', 'inapp'] as const;

/**
 * Тексты уведомлений.
 *
 * Правка сохраняется НОВОЙ версией, а не переписывает прежнюю: уведомление уже
 * ушло пользователю по старому тексту, и подменять его задним числом значило бы
 * потерять то, что человек на самом деле получил. Экран это показывает: рядом с
 * активной версией видны прежние.
 *
 * Персональные данные в шаблон не подставляются — запрет проверяет сервер, и
 * отказ здесь выводится его словами.
 */
export function TemplatesPage() {
  const [items, setItems] = useState<NotificationTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    code: '',
    channel: 'push' as (typeof CHANNELS)[number],
    titleTemplate: '',
    bodyTemplate: '',
  });

  const load = useCallback(async () => {
    try {
      setItems(await api.templates());
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить шаблоны'));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.saveTemplate({
        code: form.code.trim(),
        channel: form.channel,
        locale: 'ru-RU',
        titleTemplate: form.titleTemplate.trim() === '' ? null : form.titleTemplate.trim(),
        bodyTemplate: form.bodyTemplate,
        fallbackChain: [],
        isCritical: false,
      });
      setNotice(`Сохранено версией ${saved.version}. Прежняя версия сохранена в истории.`);
      setForm({ code: '', channel: 'push', titleTemplate: '', bodyTemplate: '' });
      await load();
    } catch (err) {
      setError(problemText(err, 'Шаблон не сохранён'));
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.deactivateTemplate(id);
      setNotice('Шаблон выключен.');
      await load();
    } catch (err) {
      setError(problemText(err, 'Шаблон не выключен'));
    } finally {
      setBusy(false);
    }
  }

  /** Правка существующего: код и канал переносятся, текст открывается для замены. */
  function editFrom(template: NotificationTemplate) {
    setForm({
      code: template.code,
      channel: template.channel,
      titleTemplate: template.titleTemplate ?? '',
      bodyTemplate: template.bodyTemplate,
    });
    setNotice('Текст перенесён в форму. Сохранение создаст новую версию.');
  }

  return (
    <>
      <h1>Тексты уведомлений</h1>

      {error ? (
        <div className="alert alert--error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="alert alert--ok" role="status">
          {notice}
        </div>
      ) : null}

      <p className="muted">
        Подставлять можно доменные значения: название проекта, срок, сумму. Имена, телефоны и
        реквизиты запрещены — текст целиком уходит внешнему провайдеру доставки.
      </p>

      <div className="grid-2">
        <label className="field" htmlFor="template-code">
          <span>Код события</span>
          <input
            id="template-code"
            value={form.code}
            placeholder="season.stage.advanced"
            onChange={(event) => setForm((f) => ({ ...f, code: event.target.value }))}
          />
        </label>
        <label className="field" htmlFor="template-channel">
          <span>Канал</span>
          <select
            id="template-channel"
            value={form.channel}
            onChange={(event) =>
              setForm((f) => ({ ...f, channel: event.target.value as typeof f.channel }))
            }
          >
            {CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {channel}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="template-title">
          <span>Заголовок</span>
          <input
            id="template-title"
            value={form.titleTemplate}
            onChange={(event) => setForm((f) => ({ ...f, titleTemplate: event.target.value }))}
          />
        </label>
        <label className="field" htmlFor="template-body">
          <span>Текст</span>
          <textarea
            id="template-body"
            rows={3}
            value={form.bodyTemplate}
            placeholder="Проект «{{project_title}}» переведён на этап «{{stage_title}}»."
            onChange={(event) => setForm((f) => ({ ...f, bodyTemplate: event.target.value }))}
          />
        </label>
      </div>
      <button
        className="btn--sm"
        onClick={() => void save()}
        disabled={busy || form.code.trim() === '' || form.bodyTemplate.trim() === ''}
      >
        Сохранить новой версией
      </button>

      <h2>Существующие шаблоны</h2>
      {items === null ? <p>Загружаем шаблоны…</p> : null}
      {items?.length === 0 ? <p className="muted">Шаблонов нет.</p> : null}
      {items && items.length > 0 ? (
        // Таблица шире экрана телефона: прокрутка своя, а не у всей страницы.
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Код</th>
                <th>Канал</th>
                <th>Версия</th>
                <th>Состояние</th>
                <th>Текст</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {items.map((template) => (
                <tr key={template.id}>
                  <td>{template.code}</td>
                  <td>{template.channel}</td>
                  <td>{template.version}</td>
                  <td>
                    {template.isActive ? 'активна' : 'история'}
                    {template.isCritical ? ', критичный' : ''}
                  </td>
                  <td style={{ maxWidth: 380 }}>{template.bodyTemplate}</td>
                  <td>
                    <button className="btn--ghost btn--sm" onClick={() => editFrom(template)}>
                      Править
                    </button>
                    {template.isActive && !template.isCritical ? (
                      <button
                        className="btn--ghost btn--sm"
                        disabled={busy}
                        onClick={() => void deactivate(template.id)}
                      >
                        Выключить
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
