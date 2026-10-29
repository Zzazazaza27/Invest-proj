import { z } from 'zod';

/**
 * Страна обслуживания (план 0.2 §0г.2 п.7; таблица M081).
 *
 * Страна хранится за аккаунтом и выбирается явно; язык интерфейса — отдельно.
 * Условия страны (валюты и потолок раунда, пакеты, бесплатная граница)
 * удалены в 2.1-W05 вместе с инвестиционным процессом — остался список.
 */

export const ServiceCountryCodeSchema = z.string().regex(/^[a-z]{2}$/, 'код страны');

export const ServiceCountrySchema = z.object({
  code: ServiceCountryCodeSchema,
  isActive: z.boolean(),
  sortOrder: z.number().int(),
});
export type ServiceCountry = z.infer<typeof ServiceCountrySchema>;

export const UpdateServiceCountryRequestSchema = z.object({
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});
export type UpdateServiceCountryRequest = z.infer<typeof UpdateServiceCountryRequestSchema>;
