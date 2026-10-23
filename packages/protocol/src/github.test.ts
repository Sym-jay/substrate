import { expect, test } from 'bun:test'
import { GitHubRepo } from './github.ts'

test('repository input normalizes GitHub names and URLs', () => {
  expect(GitHubRepo.parse('harryfrzz/substrate')).toBe('harryfrzz/substrate')
  expect(GitHubRepo.parse('https://github.com/harryfrzz/substrate.git')).toBe('harryfrzz/substrate')
})

test('repository input cannot inject shell commands, credentials or arbitrary clone hosts', () => {
  for (const value of ["a/b'; echo stolen", 'https://token@github.com/a/b', 'https://evil.example/a/b',
    'git@github.com:a/b', '--upload-pack=evil', 'a/b/../../x', 'a/b?token=secret', 'a/b\ncommand']) {
    expect(GitHubRepo.safeParse(value).success).toBe(false)
  }
})
