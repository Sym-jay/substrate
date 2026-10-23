import { ClerkProvider } from '@clerk/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { ClerkApp } from './ClerkApp.tsx'
import { applyAppearance } from './app/settings.ts'
import './index.css'

// The saved motion setting, before anything is drawn.
applyAppearance()

// Sign-in is on when the control API has Clerk keys; /api/config says so and
// carries the publishable key, so builds don't need it.
async function clerkPublishableKey(): Promise<string | null> {
  try {
    const res = await fetch('/api/config')
    if (!res.ok) return null
    return ((await res.json()) as { clerkPublishableKey: string | null }).clerkPublishableKey
  } catch {
    return null
  }
}

async function start() {
  const key = await clerkPublishableKey()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {key ? (
        <ClerkProvider publishableKey={key} afterSignOutUrl="/">
          <ClerkApp />
        </ClerkProvider>
      ) : (
        <App />
      )}
    </StrictMode>,
  )
}

void start()
