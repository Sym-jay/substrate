import type { WindowsSizeName } from '@substrate/protocol'

// Each Windows size is a size of the configured instance's family, which sets
// only the family: with m8i (the default), m8i.xlarge, .2xlarge and .4xlarge.
const suffixes: Record<WindowsSizeName, string> = { small: 'xlarge', medium: '2xlarge', large: '4xlarge' }

export const instanceTypeFor = (configured: string, size: WindowsSizeName) => `${configured.split('.')[0]}.${suffixes[size]}`

export const sizeOf = (instanceType: string): WindowsSizeName | null =>
  (Object.entries(suffixes) as [WindowsSizeName, string][]).find(([, suffix]) => instanceType.endsWith(`.${suffix}`))?.[0] ?? null
