import { z } from 'zod'

export const NotificationPreferences = z.object({
  enabled: z.boolean(), successes: z.boolean(), failures: z.boolean(), attention: z.boolean(),
}).strict()
export type NotificationPreferences = z.infer<typeof NotificationPreferences>
export const NotificationStatus = z.object({
  available: z.boolean(), connected: z.boolean(), chatLabel: z.string().nullable(),
  preferences: NotificationPreferences,
  pending: z.object({ expiresAt: z.string(), chatLabel: z.string().nullable() }).nullable(),
  lastDelivery: z.object({ state: z.enum(['pending', 'sending', 'sent', 'failed', 'skipped']), at: z.string(), error: z.string().nullable() }).nullable(),
})
export type NotificationStatus = z.infer<typeof NotificationStatus>
export const TelegramConnect = z.object({ url: z.string().url(), expiresAt: z.string() })
export type TelegramConnect = z.infer<typeof TelegramConnect>
