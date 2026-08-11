import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Stack,
} from '@unicorn/ui';
import { RUBRIC_KEYS, type ExpertAssignment } from '@unicorn/contracts';
import { ApiError, api } from '../api';

/**
 * Назначения эксперта: ответ на назначение, рецензия, конфликт интересов.
 *
 * Порядок действий здесь не случаен и не является требованием интерфейса — его
 * задаёт сервер: рецензию можно подать только по ПРИНЯТОМУ назначению, и
 * только один раз. Кабинет не повторяет эти проверки, он показывает состояние
 * и объясняет отказ словами сервера.
 */
export function AssignmentsPage() {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: ExpertAssignment[] }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewFor, setReviewFor] = useState<ExpertAssignment | null>(null);
  const [conflictFor, setConflictFor] = useState<ExpertAssignment | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', items: await api.experts.assignments() });
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : 'Сервис недоступен',
        traceId: error instanceof ApiError ? error.traceId : null,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, okText: string) => {
      setBusy(key);
      setNotice(null);
      try {
        await action();
        setNotice({ tone: 'ok', text: okText });
        await load();
      } catch (error) {
        setNotice({
          tone: 'error',
          text:
            error instanceof ApiError
              ? (error.problem?.detail ?? error.message)
              : 'Сервис недоступен',
        });
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <Stack gap="var(--u-space-5)">
      <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>Мои назначения</h1>

      {notice ? (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          style={{
            padding: 'var(--u-space-3) var(--u-space-4)',
            borderRadius: 'var(--u-radius-md)',
            background:
              notice.tone === 'error' ? 'var(--u-danger-subtle)' : 'var(--u-success-subtle)',
            color: notice.tone === 'error' ? 'var(--u-danger)' : 'var(--u-success)',
          }}
        >
          {notice.text}
        </div>
      ) : null}

      {state.status === 'loading' ? <LoadingState label="Загружаем назначения" /> : null}
      {state.status === 'error' ? (
        <ErrorState
          description={state.message}
          traceId={state.traceId}
          onRetry={() => void load()}
        />
      ) : null}

      {state.status === 'ready' && state.items.length === 0 ? (
        <EmptyState
          title="Назначений нет"
          description="Проекты на рецензию назначает организатор. Когда назначение появится, оно будет здесь вместе со сроком."
        />
      ) : null}

      {state.status === 'ready' && state.items.length > 0 ? (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: 'var(--u-space-4)',
          }}
        >
          {state.items.map((assignment) => (
            <li key={assignment.id}>
              <Card style={{ display: 'grid', gap: 'var(--u-space-3)' }}>
                <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
                  <Badge tone={STATUS_TONE[assignment.status] ?? 'neutral'}>
                    {STATUS_LABEL[assignment.status] ?? assignment.status}
                  </Badge>
                  <Badge>до {new Date(assignment.dueAt).toLocaleDateString('ru-RU')}</Badge>
                </div>
                <strong style={{ fontSize: 'var(--u-text-lg)' }}>{assignment.projectTitle}</strong>

                <div style={{ display: 'flex', gap: 'var(--u-space-3)', flexWrap: 'wrap' }}>
                  {assignment.status === 'assigned' ? (
                    <>
                      <Button
                        loading={busy === `accept-${assignment.id}`}
                        onClick={() =>
                          run(
                            `accept-${assignment.id}`,
                            () => api.experts.decideAssignment(assignment.id, 'accepted'),
                            'Назначение принято',
                          )
                        }
                      >
                        Принять
                      </Button>
                      <Button
                        variant="secondary"
                        loading={busy === `decline-${assignment.id}`}
                        onClick={() =>
                          run(
                            `decline-${assignment.id}`,
                            () => api.experts.decideAssignment(assignment.id, 'declined'),
                            'Назначение отклонено',
                          )
                        }
                      >
                        Отказаться
                      </Button>
                    </>
                  ) : null}

                  {assignment.status === 'accepted' ? (
                    <Button onClick={() => setReviewFor(assignment)}>Написать рецензию</Button>
                  ) : null}

                  <Button variant="ghost" onClick={() => setConflictFor(assignment)}>
                    Заявить конфликт интересов
                  </Button>
                </div>

                {reviewFor?.id === assignment.id ? (
                  <ReviewForm
                    assignment={assignment}
                    onCancel={() => setReviewFor(null)}
                    onDone={(text, tone) => {
                      setReviewFor(null);
                      setNotice({ tone, text });
                      void load();
                    }}
                  />
                ) : null}

                {conflictFor?.id === assignment.id ? (
                  <ConflictForm
                    assignment={assignment}
                    onCancel={() => setConflictFor(null)}
                    onDone={(text, tone) => {
                      setConflictFor(null);
                      setNotice({ tone, text });
                      void load();
                    }}
                  />
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </Stack>
  );
}

const STATUS_LABEL: Record<string, string> = {
  assigned: 'Ожидает ответа',
  accepted: 'Принято',
  declined: 'Отклонено',
  completed: 'Рецензия сдана',
  expired: 'Просрочено',
};

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning'> = {
  assigned: 'accent',
  accepted: 'accent',
  declined: 'neutral',
  completed: 'success',
  expired: 'warning',
};

const RUBRIC_LABEL: Record<string, string> = {
  team: 'Команда',
  product: 'Продукт',
  strategy: 'Стратегия',
  legal: 'Юридическая часть',
  finmodel: 'Финмодель',
  scalability: 'Масштабируемость',
};

/**
 * Форма рецензии.
 *
 * Все шесть осей обязательны: пропуск оси — это не «ноль», а отсутствие
 * оценки, и сервер такую рецензию не примет. Поэтому поля обязательны и здесь,
 * чтобы отказ не приходил после заполнения половины формы.
 */
function ReviewForm({
  assignment,
  onCancel,
  onDone,
}: {
  assignment: ExpertAssignment;
  onCancel: () => void;
  onDone: (text: string, tone: 'ok' | 'error') => void;
}) {
  const [scores, setScores] = useState<Record<string, string>>(
    Object.fromEntries(RUBRIC_KEYS.map((key) => [key, '5'])),
  );
  const [comment, setComment] = useState('');
  const [recommendation, setRecommendation] = useState<'pass' | 'fail' | 'needs_review'>('pass');
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await api.experts.submitReview({
            assignmentId: assignment.id,
            rubricScores: Object.fromEntries(
              RUBRIC_KEYS.map((key) => [key, Number(scores[key])]),
            ) as Record<(typeof RUBRIC_KEYS)[number], number>,
            comment: comment || undefined,
            recommendation,
          });
          onDone('Рецензия отправлена', 'ok');
        } catch (error) {
          onDone(
            error instanceof ApiError
              ? (error.problem?.detail ?? error.message)
              : 'Сервис недоступен',
            'error',
          );
        } finally {
          setBusy(false);
        }
      }}
      style={{
        borderTop: '1px solid var(--u-border)',
        paddingTop: 'var(--u-space-4)',
        display: 'grid',
        gap: 'var(--u-space-3)',
      }}
    >
      <strong>Рецензия по рубрике</strong>
      {RUBRIC_KEYS.map((key) => (
        <Field key={key} label={RUBRIC_LABEL[key] ?? key} htmlFor={`score-${key}`}>
          <Input
            id={`score-${key}`}
            type="number"
            min={0}
            max={10}
            step={1}
            required
            value={scores[key]}
            onChange={(event) => setScores({ ...scores, [key]: event.target.value })}
          />
        </Field>
      ))}

      <Field label="Комментарий" htmlFor="comment" hint="Необязателен, но помогает организатору">
        <Input
          id="comment"
          maxLength={8000}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </Field>

      <Field label="Рекомендация" htmlFor="recommendation">
        <select
          id="recommendation"
          value={recommendation}
          onChange={(event) =>
            setRecommendation(event.target.value as 'pass' | 'fail' | 'needs_review')
          }
          style={SELECT_STYLE}
        >
          <option value="pass">Пропустить дальше</option>
          <option value="needs_review">Нужна доработка</option>
          <option value="fail">Отклонить</option>
        </select>
      </Field>

      <div style={{ display: 'flex', gap: 'var(--u-space-3)' }}>
        <Button type="submit" loading={busy}>
          Отправить рецензию
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

/**
 * Декларация конфликта интересов.
 *
 * Заявляется до работы: неразрешённый конфликт блокирует назначение на уровне
 * БД, и решение принимает комплаенс, а не сам эксперт.
 */
function ConflictForm({
  assignment,
  onCancel,
  onDone,
}: {
  assignment: ExpertAssignment;
  onCancel: () => void;
  onDone: (text: string, tone: 'ok' | 'error') => void;
}) {
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await api.experts.declareConflict({
            projectId: assignment.projectId,
            description,
          });
          onDone('Конфликт заявлен — решение принимает комплаенс', 'ok');
        } catch (error) {
          onDone(
            error instanceof ApiError
              ? (error.problem?.detail ?? error.message)
              : 'Сервис недоступен',
            'error',
          );
        } finally {
          setBusy(false);
        }
      }}
      style={{
        borderTop: '1px solid var(--u-border)',
        paddingTop: 'var(--u-space-4)',
        display: 'grid',
        gap: 'var(--u-space-3)',
      }}
    >
      <Field
        label="В чём конфликт"
        htmlFor={`conflict-${assignment.id}`}
        hint="Не менее 10 символов: описание читает комплаенс"
      >
        <Input
          id={`conflict-${assignment.id}`}
          required
          minLength={10}
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <div style={{ display: 'flex', gap: 'var(--u-space-3)' }}>
        <Button type="submit" loading={busy}>
          Заявить
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

const SELECT_STYLE: React.CSSProperties = {
  minHeight: 44,
  padding: '0 var(--u-space-3)',
  borderRadius: 'var(--u-radius-md)',
  border: '1px solid var(--u-border-strong)',
  background: 'var(--u-surface)',
  color: 'var(--u-text)',
  fontSize: 'var(--u-text-md)',
  fontFamily: 'inherit',
  width: '100%',
};
