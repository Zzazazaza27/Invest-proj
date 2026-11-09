import { settleBasis } from '../audit/actor-context';
import type { RequestContext, Tx } from '../db/unit-of-work';

/**
 * Кем человек действует над проектом (блок 10). Повторяет условие политики
 * изменения проекта — участник проекта ИЛИ администратор — и отмечает, какая часть
 * условия выполнилась. Участник — достаточное основание и проверяется первым:
 * администратор, который сам в команде проекта, действует как участник.
 *
 * Прав не даёт: если не выполнилось ни одно, изменение уже отклонено RLS/проверкой
 * сервиса; здесь возвращается роль только для записи в журнал.
 */
export async function actingOnProject(
  tx: Tx,
  ctx: RequestContext,
  projectId: string,
): Promise<'founder' | 'admin'> {
  const { rows } = await tx.query<{ member: boolean }>(
    'SELECT lab.is_project_member($1, app.current_user_id()) AS member',
    [projectId],
  );
  if (rows[0]?.member === true) {
    settleBasis(ctx.actor, { check: 'member', object: `project:${projectId}` });
    return 'founder';
  }
  if (ctx.roles.includes('admin')) {
    settleBasis(ctx.actor, { check: 'route-role', role: 'admin' });
    return 'admin';
  }
  // Ни одно не выполнилось: запись журнала будет отклонена расхождением с основанием.
  return 'founder';
}
