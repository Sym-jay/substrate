import { Show, SignInButton, SignUpButton, UserButton, useAuth, useUser } from '@clerk/react'
import { useRoute } from './app/router.ts'
import { App } from './App.tsx'
import { setTokenSource } from './auth.ts'

export function ClerkApp() {
  const { getToken } = useAuth()
  const { user } = useUser()
  // Set while rendering, not in an effect: children's effects (which load
  // VMs) run before their parent's, and need the token already.
  setTokenSource(() => getToken())

  return (
    <>
      <Show when="signed-in">
        <App account={<UserButton />} userName={user?.firstName ?? user?.username ?? null} />
      </Show>
      <Show when="signed-out">
        <SignedOut />
      </Show>
    </>
  )
}

function SignedOut() {
  const route = useRoute()
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-8 px-5 py-10">
      <div className="hero card rise flex flex-col gap-6">
        <header className="relative z-10 flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-11" />
          <div>
            <h1 className="heading text-2xl font-semibold tracking-tight">Substrate</h1>
            <p className="text-muted text-sm">Persistent sandboxes for coding agents</p>
          </div>
        </header>
        <p className="text-muted relative z-10 leading-relaxed">
          Launch a workspace with Claude Code, Codex or a plain shell, and open its terminal from any device. Your agents keep running when you close the tab.
        </p>
        {route.page === 'cli' && <p className="text-muted relative z-10 text-sm">Sign in to review CLI request <code>{route.params[0]}</code>. Signing in alone does not authorize access.</p>}
        <div className="relative z-10 flex flex-wrap gap-3">
          <SignInButton mode="modal">
            <button type="button" className="btn btn-primary btn-lg">Sign in</button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button type="button" className="btn btn-secondary btn-lg">Create an account</button>
          </SignUpButton>
        </div>
      </div>
    </main>
  )
}
