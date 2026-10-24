import { Show, SignInButton, SignUpButton, UserButton, useAuth, useClerk, useUser } from '@clerk/react'
import { ArrowRight } from 'lucide-react'
import { useRoute } from './app/router.ts'
import { App } from './App.tsx'
import { Button, Toasts } from './app/ui.tsx'
import { WelcomeHero } from './pages/WelcomePage.tsx'
import { setTokenSource } from './auth.ts'

export function ClerkApp() {
  const { getToken } = useAuth()
  const { user } = useUser()
  const { openUserProfile, signOut } = useClerk()
  // Set while rendering, not in an effect: children's effects (which load
  // VMs) run before their parent's, and need the token already.
  setTokenSource(() => getToken())

  return (
    <>
      <Show when="signed-in">
        <App
          account={<UserButton />}
          userName={user?.firstName ?? user?.username ?? null}
          profile={user ? {
            name: user.fullName ?? user.username ?? null,
            email: user.primaryEmailAddress?.emailAddress ?? null,
            imageUrl: user.imageUrl || null,
            since: user.createdAt ?? null,
            manage: () => openUserProfile(),
            signOut: () => void signOut(),
          } : undefined}
        />
      </Show>
      <Show when="signed-out">
        <SignedOut />
      </Show>
    </>
  )
}

// The welcome page, before signing in: launching starts there.
function SignedOut() {
  const route = useRoute()
  return (
    <Toasts>
      <main className="signed-out">
        <WelcomeHero
          launch={<SignInButton mode="modal"><Button variant="primary" size="lg" live>{route.page === 'cli' ? 'Sign in' : 'Launch instance'}</Button></SignInButton>}
          more={<>
            {/* A CLI asking for access: signing in only leads to the request, which is approved separately. */}
            {route.page === 'cli' && <p className="text-muted text-sm">Sign in to review CLI request <code>{route.params[0]}</code>. Signing in alone does not authorize access.</p>}
            <SignUpButton mode="modal"><button type="button" className="welcome-more">New here? Create an account<ArrowRight /></button></SignUpButton>
          </>}
        />
      </main>
    </Toasts>
  )
}
