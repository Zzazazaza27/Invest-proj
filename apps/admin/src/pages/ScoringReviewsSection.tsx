import { useCallback, useEffect, useState } from 'react';
import type { ScoringReviewItem } from '@unicorn/contracts';
import { PromptDialog } from '@unicorn/ui';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Оценки ИИ, ждущие решения человека (ADR-008 §4).
 *
 * Два независимых решения по одному паспорту:
 *  * потолки и штрафы — «подтвердить» переносит предложенный балл в
 *    публикуемый, «отклонить» оставляет базовый;
 *  * флаги комплаенса — «разрешить публикацию» или «закрыть»; до решения
 *    листинг не публикуется.
 *
 * Здесь нет автоматики намеренно: суждение модели, меняющее позицию проекта в
 * рейтинге или закрывающее ему публикацию, требует человека и основания.
 */

const CAP_TITLES: Record<string, string> = {
  no_verifiable_activity_claims: 'нет проверяемых утверждений о деятельности',
  business_model_missing: 'не описана бизнес-модель',
  numbers_contradict: 'числа заявки противоречат друг другу',
  no_product_customer_money: 'нет утверждений о продукте, покупателе и деньгах',
  legal_form_missing: 'правовая форма и права на разработку не упомянуты',
  ask_without_use_of_funds: 'сумма без назначения средств',
};

const PENALTY_TITLES: Record<string, string> = {
  no_competitors_claim: '«конкурентов нет»',
  single_channel: 'единственный канал привлечения',
  single_supplier_dependency: 'зависимость от одного поставщика',
  growth_without_absolute_numbers: 'рост без абсолютных чисел',
  stage_mismatch: 'стадия не соответствует описанию',
};

const COMPLIANCE_TITLES: Record<string, string> = {
  guaranteed_return: 'обещание гарантированной доходности',
  no_risk_claim: 'утверждение об отсутствии риска',
  unlicensed_regulated_activity: 'регулируемая деятельность без лицензии',
  third_party_allegation: 'обвинение в адрес третьих лиц',
  misleading_authority_claim: 'ссылка на несуществующее одобрение',
};

type Pending = { item: ScoringReviewItem; decision: 'confirm' | 'reject' | 'allow' | 'block' };

const DECISION_TITLES: Record<Pending['decision'], string> = {
  confirm: 'Подтвердить потолки и штрафы',
  reject: 'Отклонить потолки и штрафы',
  allow: 'Разрешить публикацию',
  block: 'Закрыть публикацию',
};

export function ScoringReviewsSection() {
  const [items, setItems] = useState<ScoringReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api.scoringReviews()).items);
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить очередь оценок'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h2 style={{ marginTop: 24 }}>Оценки ИИ, ждущие решения</h2>
      <p className="page-hint">
        Модель предложила потолки, штрафы или флаги комплаенса. Пока решение не принято, в рейтинге
        стоит базовый балл, а листинг с флагами комплаенса не публикуется.
      </p>
      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}
      {items === null && <div className="spinner">Загрузка…</div>}
      {items !== null && items.length === 0 && (
        <div className="card empty">Очередь пуста — решений по оценкам не требуется.</div>
      )}
      {items !== null && items.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Проект</th>
                <th>Балл</th>
                <th>Потолки и штрафы</th>
                <th>Комплаенс</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.passportId}>
                  <td>
                    <div>{item.projectTitle}</div>
                    <div className="small muted">
                      паспорт v{item.passportVersion}
                      {item.publishedAt ? ` · ${formatDate(item.publishedAt)}` : ''}
                    </div>
                  </td>
                  <td>
                    <div>
                      публикуется <strong>{item.score10Published}/10</strong>
                    </div>
                    <div className="small muted">
                      базовый {item.score10Base}/10 · с потолками {item.score10Proposed}/10
                    </div>
                  </td>
                  <td className="small">
                    {item.reviewStatus === 'pending' ? (
                      <>
                        {item.capsApplied.map((cap) => (
                          <div key={cap.rule}>
                            потолок {cap.cap}: {CAP_TITLES[cap.rule] ?? cap.rule}
                          </div>
                        ))}
                        {item.penaltiesApplied.map((p) => (
                          <div key={p}>−1: {PENALTY_TITLES[p] ?? p}</div>
                        ))}
                        <div className="row-actions" style={{ marginTop: 6 }}>
                          <button
                            type="button"
                            className="btn--sm"
                            onClick={() => setPending({ item, decision: 'confirm' })}
                          >
                            Подтвердить
                          </button>
                          <button
                            type="button"
                            className="btn--ghost btn--sm"
                            onClick={() => setPending({ item, decision: 'reject' })}
                          >
                            Отклонить
                          </button>
                        </div>
                      </>
                    ) : (
                      <span className="muted">решение принято: {item.reviewStatus}</span>
                    )}
                  </td>
                  <td className="small">
                    {item.complianceStatus === 'pending' ? (
                      <>
                        {item.complianceFlags.map((flag) => (
                          <div key={flag}>{COMPLIANCE_TITLES[flag] ?? flag}</div>
                        ))}
                        <div className="row-actions" style={{ marginTop: 6 }}>
                          <button
                            type="button"
                            className="btn--sm"
                            onClick={() => setPending({ item, decision: 'allow' })}
                          >
                            Разрешить публикацию
                          </button>
                          <button
                            type="button"
                            className="btn--danger btn--sm"
                            onClick={() => setPending({ item, decision: 'block' })}
                          >
                            Закрыть
                          </button>
                        </div>
                      </>
                    ) : item.complianceFlags.length === 0 ? (
                      <span className="muted">флагов нет</span>
                    ) : (
                      <span className="muted">решение принято: {item.complianceStatus}</span>
                    )}
                  </td>
                  <td className="small muted">
                    {item.integrityFlags.length > 0
                      ? `сигналы вмешательства: ${item.integrityFlags.join(', ')}`
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PromptDialog
        open={pending !== null}
        title={pending ? `${DECISION_TITLES[pending.decision]}: ${pending.item.projectTitle}` : ''}
        description="Основание попадёт в журнал прогона и в неизменяемый аудит вместе с автором решения."
        label="Основание"
        confirmText={pending ? DECISION_TITLES[pending.decision] : 'Подтвердить'}
        onCancel={() => setPending(null)}
        onConfirm={(reason) => {
          const current = pending;
          setPending(null);
          if (!current) return;
          setNotice(null);
          void api
            .decideScoringReview(current.item.passportId, current.decision, reason)
            .then(() => {
              setNotice('Решение записано.');
              return load();
            })
            .catch((err: unknown) => setError(problemText(err, 'Решение не записано')));
        }}
      />
    </>
  );
}
