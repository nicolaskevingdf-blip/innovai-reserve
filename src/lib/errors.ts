/** Turns Postgres / Supabase errors into human messages (pt-BR). */
export function errorMessage(err: unknown): string {
  if (!err) return 'Algo deu errado.'
  const e = err as { message?: string; code?: string; hint?: string; details?: string }
  switch (e.code) {
    case '23P01':
      if (e.message?.includes('duplicate_customer')) return 'Este cliente já possui uma reserva que coincide com este horário.'
      return 'Conflito de agenda: já existe uma reserva neste horário.'
    case '23505':
      return 'Registro duplicado.'
    case '42501':
      return e.message?.match(/[À-ú]/) ? e.message : 'Você não tem permissão para esta ação.'
    case 'PGRST116':
      return 'Registro não encontrado.'
  }
  if (e.message === 'Failed to fetch') return 'Sem conexão com o servidor. Verifique sua internet.'
  if (e.message?.includes('Invalid login credentials')) return 'E-mail ou senha incorretos.'
  if (e.message?.includes('Email not confirmed')) return 'Confirme seu e-mail antes de entrar (verifique sua caixa de entrada).'
  if (e.message?.includes('User already registered')) return 'Já existe uma conta com este e-mail.'
  return e.message || 'Algo deu errado.'
}

export const errorHint = (err: unknown) => (err as { hint?: string })?.hint
