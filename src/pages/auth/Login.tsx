import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { errorMessage } from '@/lib/errors'
import { useAuth } from '@/hooks/useAuth'
import { Button, Field, Input } from '@/components/ui/ui'
import { AuthLayout } from './AuthLayout'

export default function Login() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const next = params.get('next') || '/app'
  if (user) return <Navigate to={next} replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true); setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setLoading(false)
    if (error) return setError(errorMessage(error))
    navigate(next, { replace: true })
  }

  return (
    <AuthLayout title="Entrar" subtitle="Acesse o painel do seu estabelecimento." footer={<>Ainda não tem conta? <Link to="/cadastro" className="font-semibold text-lime hover:underline">Criar conta</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="E-mail"><Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Senha" hint={<Link to="/recuperar-senha" className="hover:text-lime">Esqueceu?</Link>}>
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error && <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3.5 py-2.5 text-sm text-rose-200">{error}</p>}
        <Button type="submit" size="lg" className="w-full" loading={loading}>Entrar</Button>
      </form>
    </AuthLayout>
  )
}
