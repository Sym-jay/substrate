import { z } from 'zod'

// Accept only a GitHub owner/repository or its HTTPS URL. Credentials and
// arbitrary git transports never come from a browser request.
export const GitHubRepo = z.string().trim().transform((value, context) => {
  const match = /^(?:https:\/\/github\.com\/)?([a-zA-Z0-9][a-zA-Z0-9-]{0,38})\/([a-zA-Z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(value)
  if (!match || ['.', '..'].includes(match[2]!)) {
    context.addIssue({ code: 'custom', message: 'Use owner/repository or a github.com HTTPS URL' })
    return z.NEVER
  }
  return `${match[1]}/${match[2]}`
})

export const AgentMode = z.enum(['ask', 'auto'])
export type AgentMode = z.infer<typeof AgentMode>
