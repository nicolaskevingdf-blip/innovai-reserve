import { Link } from 'react-router-dom'
import { Logo } from '@/components/layout/Logo'

export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center bg-ink-950 p-6 grid-bg">
      <div className="text-center animate-fade-up">
        <Logo className="justify-center" />
        <p className="mt-10 font-display text-7xl font-extrabold text-ink-700">404</p>
        <h1 className="mt-2 text-xl font-semibold">Página não encontrada</h1>
        <p className="mt-2 text-sm text-ink-400">O link pode estar incorreto ou o estabelecimento não está mais disponível.</p>
        <Link to="/" className="mt-6 inline-flex h-10 items-center rounded-xl bg-lime px-5 text-sm font-semibold text-ink-950">Voltar ao início</Link>
      </div>
    </div>
  )
}
