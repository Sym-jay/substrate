import { Show, SignInButton, SignUpButton, UserButton, useAuth } from '@clerk/react'
import { App } from './App.tsx'
import { setTokenSource } from './auth.ts'

export function ClerkApp() {
  const { getToken } = useAuth()
  // Set while rendering, not in an effect: children's effects (which load
  // VMs) run before their parent's, and need the token already.
  setTokenSource(() => getToken())

  return (
    <>
      <Show when="signed-in">
        <App account={<UserButton />} />
      </Show>
      <Show when="signed-out">
        <SignedOut />
      </Show>
    </>
  )
}

function SignedOut() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-8 px-4 py-10">
      <header className="flex items-center gap-3">
        <img src="/favicon.svg" alt="" className="size-10" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Substrate</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Persistent sandboxes for coding agents</p>
        </div>
      </header>
      <p className="text-zinc-600 dark:text-zinc-300">
        Sign in to create VMs and open their terminals from any device. Your agents keep running when you close
        the tab.
      </p>
      <div className="flex flex-wrap gap-3">
        <SignInButton mode="modal">
          <button
            type="button"
            className="rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Sign in
          </button>
        </SignInButton>
        <SignUpButton mode="modal">
          <button
            type="button"
            className="rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Create an account
          </button>
        </SignUpButton>
      </div>
    </main>
  )
}
