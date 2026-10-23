import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms'
import type { Db } from './db.ts'

// Encrypts and decrypts with an encryption context: a ciphertext only
// decrypts for the same user and name, so rows can't be swapped between users.
export interface Cipher {
  encrypt(plaintext: string, context: Record<string, string>): Promise<string>
  decrypt(ciphertext: string, context: Record<string, string>): Promise<string>
}

export function kmsCipher(region: string, keyId: string): Cipher {
  const kms = new KMSClient({ region })
  return {
    async encrypt(plaintext, context) {
      const { CiphertextBlob } = await kms.send(new EncryptCommand({ KeyId: keyId, Plaintext: Buffer.from(plaintext), EncryptionContext: context }))
      return Buffer.from(CiphertextBlob!).toString('base64')
    },
    async decrypt(ciphertext, context) {
      const { Plaintext } = await kms.send(new DecryptCommand({ KeyId: keyId, CiphertextBlob: Buffer.from(ciphertext, 'base64'), EncryptionContext: context }))
      return Buffer.from(Plaintext!).toString()
    },
  }
}

export type SecretName = 'anthropic' | 'openai' | 'github'

// Users' own secrets: agent API keys and GitHub tokens. Only ciphertext is
// stored; the browser only ever gets back a hint.
export class UserSecrets {
  constructor(private readonly db: Db, private readonly cipher: Cipher) {}

  private context = (userId: string, name: SecretName) => ({ purpose: 'substrate-user-secret', user: userId, name })

  async set(userId: string, name: SecretName, value: string, hint: string) {
    const ciphertext = await this.cipher.encrypt(value, this.context(userId, name))
    await this.db`insert into user_secrets (user_id, name, ciphertext, hint, updated_at) values (${userId}, ${name}, ${ciphertext}, ${hint}, ${new Date().toISOString()})
      on conflict (user_id, name) do update set ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = excluded.updated_at`
  }

  async get(userId: string, name: SecretName) {
    const [row] = await this.db`select ciphertext from user_secrets where user_id = ${userId} and name = ${name}`
    return row ? this.cipher.decrypt(row.ciphertext, this.context(userId, name)) : null
  }

  async list(userId: string): Promise<{ name: SecretName; hint: string; updatedAt: string }[]> {
    const rows = await this.db`select name, hint, updated_at from user_secrets where user_id = ${userId} order by name`
    return rows.map((row: { name: SecretName; hint: string; updated_at: string }) => ({ name: row.name, hint: row.hint, updatedAt: row.updated_at }))
  }

  async remove(userId: string, name: SecretName) {
    await this.db`delete from user_secrets where user_id = ${userId} and name = ${name}`
  }
}
