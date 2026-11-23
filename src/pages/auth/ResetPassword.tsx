import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { errorMessage } from '@/lib/errors'
import { Button, Field, Input } from '@/components/ui/ui'
import { useToast } from '@/components/ui/Toast'
import { AuthLayout } from './AuthLayout'

export default function ResetPassword() {
  const navigate = useNavigate()
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (password.length < 8) return setError('A senha deve ter pelo menos 8 caracteres.')
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) return setError(errorMessage(error))
    toast('success', 'Senha atualizada')
    navigate('/app', { replace: true })
  }
  return (
    <AuthLayout title="Nova senha" subtitle="Defina uma nova senha para sua conta.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nova senha"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required /></Field>
        {error && <p className="text-sm text-rose-300">{error}</p>}
        <Button type="submit" size="lg" className="w-full" loading={loading}>Salvar senha</Button>
      </form>
    </AuthLayout>
  )
}
