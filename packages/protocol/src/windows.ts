import { z } from 'zod'
import { VmName } from './vm.ts'

// Windows workspaces (M9): an EC2 instance each, from the Substrate Windows
// image, with terminals over SSH and the desktop over VNC, both through the
// control box.

// creating: its first boot (5 to 10 minutes). starting: booting again after
// being stopped. A stopped workspace costs only its disk.
export const WindowsWorkspaceState = z.enum(['creating', 'starting', 'running', 'stopping', 'stopped', 'failed'])
export type WindowsWorkspaceState = z.infer<typeof WindowsWorkspaceState>

export const WindowsWorkspace = z.object({
  id: z.string(),
  name: z.string(),
  state: WindowsWorkspaceState,
  instanceType: z.string(),
  createdAt: z.string(),
  // Stops itself after this long without anyone typing and with the CPU
  // quiet. Null never stops it.
  idleStopMinutes: z.number().int().nullable(),
  error: z.string().nullable(),
})
export type WindowsWorkspace = z.infer<typeof WindowsWorkspace>

export const CreateWindowsWorkspace = z.object({ name: VmName })
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
