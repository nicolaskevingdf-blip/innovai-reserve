import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { MailCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { errorMessage } from '@/lib/errors'
import { useAuth } from '@/hooks/useAuth'
import { Button, Field, Input } from '@/components/ui/ui'
import { AuthLayout } from './AuthLayout'

export default function Signup() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  if (user) return <Navigate to="/app" replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (password.length < 8) return setError('A senha deve ter pelo menos 8 caracteres.')
    setLoading(true); setError(null)
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(), password,
      options: { data: { full_name: name.trim() }, emailRedirectTo: `${window.location.origin}/onboarding` },
    })
    setLoading(false)
    if (error) return setError(errorMessage(error))
    if (data.session) navigate('/onboarding', { replace: true })
    else setSent(true) // e-mail confirmation enabled in Supabase Auth
  }

  if (sent) {
    return (
      <AuthLayout title="Confirme seu e-mail" subtitle={<>Enviamos um link para <b className="text-ink-100">{email}</b>. Abra-o para ativar sua conta e configurar o estabelecimento.</>}
        footer={<Link to="/entrar" className="font-semibold text-lime hover:underline">Já confirmei, entrar</Link>}>
        <div className="grid h-24 w-24 place-items-center rounded-3xl border border-lime/30 bg-lime/10 text-lime"><MailCheck className="h-10 w-10" /></div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Criar conta" subtitle="Comece a receber reservas online em poucos minutos."
      footer={<>Já tem conta? <Link to="/entrar" className="font-semibold text-lime hover:underline">Entrar</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Seu nome"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></Field>
        <Field label="E-mail"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></Field>
        <Field label="Senha" hint="mín. 8 caracteres"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required /></Field>
        {error && <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3.5 py-2.5 text-sm text-rose-200">{error}</p>}
        <Button type="submit" size="lg" className="w-full" loading={loading}>Criar conta</Button>
        <p className="text-center text-xs text-ink-500">Foi convidado por um estabelecimento? Use o mesmo e-mail do convite.</p>
      </form>
    </AuthLayout>
  )
}
