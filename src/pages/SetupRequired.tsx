import { Logo } from '@/components/layout/Logo'

export function SetupRequired() {
  return (
    <div className="grid min-h-screen place-items-center bg-ink-950 p-6 grid-bg">
      <div className="card max-w-lg p-8">
        <Logo />
        <h1 className="mt-6 text-2xl font-bold">Conecte o Supabase</h1>
        <p className="mt-2 text-sm text-ink-300">
          Crie um arquivo <code className="rounded bg-ink-800 px-1.5 py-0.5 text-lime">.env</code> na raiz do projeto com as credenciais do seu projeto Supabase
          e reinicie o servidor de desenvolvimento.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-xl border border-ink-700 bg-ink-850 p-4 text-xs text-ink-200">{`VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
VITE_SUPABASE_ANON_KEY=sua-anon-key
VITE_PUBLIC_BASE_URL=http://localhost:5173`}</pre>
        <p className="mt-4 text-xs text-ink-400">Depois aplique as migrations em <code>supabase/migrations</code> (veja o README).</p>
      </div>
    </div>
  )
}
