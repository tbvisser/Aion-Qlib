import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/hooks/useTheme'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

// Adapted from Aion-RAG's components/auth/AuthForm.tsx: brand.ts swapped for
// the qlib wordmark assets, everything else kept. The local Supabase stack
// runs with email autoconfirm, so sign-up logs the user straight in — no
// "check your email" interstitial.
export function LoginPage() {
  const { theme } = useTheme()
  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const { signIn, signUp } = useAuth()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      if (isSignUp) {
        await signUp(email, password)
      } else {
        await signIn(email, password)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
      <img
        src={theme === 'dark' ? '/brand/aion-wordmark-mint.svg' : '/brand/aion-wordmark-ink.svg'}
        alt="AION"
        className="animate-fade-in mb-8 h-8"
      />
      <Card className="animate-fade-in w-full max-w-md border-border/50 bg-card shadow-card">
        <CardHeader className="space-y-2 pb-6">
          <CardTitle className="text-2xl font-semibold tracking-tight">
            {isSignUp ? 'Create Account' : 'Welcome back'}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {isSignUp
              ? 'Enter your email to create a new account'
              : 'Enter your credentials to access your account'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <Input
                id="password"
                type="password"
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                className="h-11"
              />
            </div>

            {error && (
              <div className="animate-fade-in rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <Button type="submit" className="h-11 w-full text-base" disabled={loading}>
              {loading ? 'Loading...' : isSignUp ? 'Sign Up' : 'Sign In'}
            </Button>

            <div className="text-center text-sm text-muted-foreground">
              {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
              <button
                type="button"
                className="font-medium text-primary underline-offset-4 transition-colors hover:underline"
                onClick={() => {
                  setIsSignUp(!isSignUp)
                  setError(null)
                }}
              >
                {isSignUp ? 'Sign In' : 'Sign Up'}
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
