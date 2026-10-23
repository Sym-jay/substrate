import { z } from 'zod'
import { config } from './config.ts'

// Written by images/guest/build-images.sh after a successful build.
export const ImageInfo = z.object({
  version: z.string(),
  // ZFS snapshot each VM's root disk is cloned from.
  rootfs: z.string(),
  kernel: z.string(),
  builtAt: z.string(),
  tools: z.record(z.string(), z.string()).default({}),
})
export type ImageInfo = z.infer<typeof ImageInfo>

export async function currentImage(): Promise<ImageInfo | null> {
  const file = Bun.file(config.paths.image)
  if (!(await file.exists())) return null
  return ImageInfo.parse(await file.json())
}
