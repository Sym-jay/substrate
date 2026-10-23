import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'

// Private-repository credentials are scoped to the signed-in user. A shared
// host token must never be injected into another user's workspace.
export function githubTokens(region: string) {
  const ssm = new SSMClient({ region })
  return async (userId: string): Promise<string | undefined> => {
    if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error('invalid GitHub credential owner')
    try {
      const result = await ssm.send(new GetParameterCommand({ Name: `/substrate/github/${userId}`, WithDecryption: true }))
      return result.Parameter?.Value
    } catch (error) {
      if (error instanceof Error && error.name === 'ParameterNotFound') return undefined
      throw error
    }
  }
}
