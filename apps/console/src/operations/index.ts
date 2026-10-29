import type { OperationGroup } from '../types';
import { publicGroup } from './public';
import { identityGroup, kycGroup } from './identity';
import { materialsGroup, projectsGroup } from './lab';
import { notificationsGroup } from './notifications';
import { adminGroup, integrationGroup } from './admin';

/**
 * Порядок групп повторяет путь через платформу: сначала проверка живости и
 * публичный контур, затем учётная запись, проект, уведомления,
 * администрирование. Прогон сверху вниз — и есть сквозной сценарий.
 */
export const GROUPS: OperationGroup[] = [
  publicGroup,
  identityGroup,
  kycGroup,
  projectsGroup,
  materialsGroup,
  notificationsGroup,
  adminGroup,
  integrationGroup,
];

export const TOTAL_OPERATIONS = GROUPS.reduce((sum, group) => sum + group.operations.length, 0);
