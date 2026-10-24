import { z } from 'zod'

export const CliDeviceCode = z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
export const CliDeviceRequest = z.object({ name: z.string().trim().min(1).max(80) })
export const CliDeviceGrant = z.object({ deviceCode: z.string(), userCode: CliDeviceCode, expiresAt: z.string(), intervalSeconds: z.number() })
export type CliDeviceGrant = z.infer<typeof CliDeviceGrant>
export const CliDeviceInfo = z.object({ name: z.string(), userCode: CliDeviceCode, expiresAt: z.string(), state: z.enum(['pending', 'approved', 'denied', 'redeemed']) })
export type CliDeviceInfo = z.infer<typeof CliDeviceInfo>
export const CliSession = z.object({ id: z.string().uuid(), name: z.string(), createdAt: z.string(), expiresAt: z.string(), lastUsedAt: z.string().nullable() })
export type CliSession = z.infer<typeof CliSession>
export const CliToken = z.object({ token: z.string(), userId: z.string(), session: CliSession })
export type CliToken = z.infer<typeof CliToken>
export const CliIdentity = z.object({ userId: z.string(), session: CliSession.nullable() })
export type CliIdentity = z.infer<typeof CliIdentity>
