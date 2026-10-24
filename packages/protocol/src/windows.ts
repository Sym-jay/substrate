import { z } from 'zod'
import { VmName } from './vm.ts'

// Windows workspaces (M9): an EC2 instance each, from the Substrate Windows
// image, with terminals over SSH and the desktop over VNC, both through the
// control box.

// creating: its first boot (5 to 10 minutes). starting: booting again after
// being stopped. A stopped workspace costs only its disk.
export const WindowsWorkspaceState = z.enum(['creating', 'starting', 'running', 'stopping', 'stopped', 'failed'])
export type WindowsWorkspaceState = z.infer<typeof WindowsWorkspaceState>

// The sizes a Windows workspace comes in. They're one instance family, so
// vCPUs and memory go up together; large is the original size, and the default.
export const WindowsSizes = {
  small: { vcpus: 4, memGib: 16 },
  medium: { vcpus: 8, memGib: 32 },
  large: { vcpus: 16, memGib: 64 },
} as const
export const WindowsSizeName = z.enum(['small', 'medium', 'large'])
export type WindowsSizeName = z.infer<typeof WindowsSizeName>
export const DEFAULT_WINDOWS_SIZE: WindowsSizeName = 'large'

export const WindowsWorkspace = z.object({
  id: z.string(),
  name: z.string(),
  state: WindowsWorkspaceState,
  instanceType: z.string(),
  // Null when its instance isn't one of the sizes (made by hand, or an old
  // setting); optional for servers from before sizes.
  size: WindowsSizeName.nullable().optional(),
  createdAt: z.string(),
  // Stops itself after this long without anyone typing and with the CPU
  // quiet. Null never stops it.
  idleStopMinutes: z.number().int().nullable(),
  error: z.string().nullable(),
})
export type WindowsWorkspace = z.infer<typeof WindowsWorkspace>

export const CreateWindowsWorkspace = z.object({ name: VmName, size: WindowsSizeName.optional() })
export type CreateWindowsWorkspace = z.infer<typeof CreateWindowsWorkspace>

export const UpdateWindowsWorkspace = z.object({
  idleStopMinutes: z.number().int().min(5).max(24 * 60).nullable(),
})
export type UpdateWindowsWorkspace = z.infer<typeof UpdateWindowsWorkspace>

// For signing in on the desktop. Only the workspace's owner gets them.
export const WindowsCredentials = z.object({
  username: z.string(),
  password: z.string(),
})
export type WindowsCredentials = z.infer<typeof WindowsCredentials>
