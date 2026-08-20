import type { OperationGroup } from '../types';
import { publicGroup } from './public';
import { identityGroup, kycGroup } from './identity';
import { analysisGroup, materialsGroup, projectsGroup } from './lab';
import { billingGroup, investmentsGroup } from './money';
import { expertsGroup, notificationsGroup, seasonsGroup } from './experts';
import { adminGroup, integrationGroup } from './admin';

/**
 * Порядок групп повторяет путь через платформу: сначала проверка живости и
 * публичный контур, затем учётная запись, проект, деньги, экспертиза,
 * администрирование. Прогон сверху вниз — и есть сквозной сценарий.
 */
export const GROUPS: OperationGroup[] = [
  publicGroup,
  identityGroup,
  kycGroup,
  projectsGroup,
  materialsGroup,
  analysisGroup,
  investmentsGroup,
  billingGroup,
  expertsGroup,
  seasonsGroup,
  notificationsGroup,
  adminGroup,
  integrationGroup,
];

export const TOTAL_OPERATIONS = GROUPS.reduce((sum, group) => sum + group.operations.length, 0);
