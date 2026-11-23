import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { errorMessage } from '@/lib/errors'
import { Button, Field, Input } from '@/components/ui/ui'
import { AuthLayout } from './AuthLayout'

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true); setError(null)
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/nova-senha` })
    setLoading(false)
    if (error) setError(errorMessage(error)); else setDone(true)
  }
  return (
    <AuthLayout title="Recuperar senha" subtitle={done ? 'Se existir uma conta com este e-mail, você receberá um link para criar uma nova senha.' : 'Enviaremos um link para o seu e-mail.'}
      footer={<Link to="/entrar" className="font-semibold text-lime hover:underline">Voltar para o login</Link>}>
      {!done && (
        <form onSubmit={submit} className="space-y-4">
          <Field label="E-mail"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          {error && <p className="text-sm text-rose-300">{error}</p>}
          <Button type="submit" size="lg" className="w-full" loading={loading}>Enviar link</Button>
        </form>
      )}
    </AuthLayout>
  )
}
