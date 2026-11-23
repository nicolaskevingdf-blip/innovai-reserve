import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

type Kind = 'success' | 'error' | 'info'
interface ToastItem { id: number; kind: Kind; title: string; description?: string }

const ToastCtx = createContext<{ toast: (kind: Kind, title: string, description?: string) => void } | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const toast = useCallback((kind: Kind, title: string, description?: string) => {
    const id = Date.now() + Math.random()
    setItems((s) => [...s.slice(-3), { id, kind, title, description }])
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3500)
  }, [])
  const Icon = { success: CheckCircle2, error: AlertCircle, info: Info }
  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex flex-col items-center gap-2 px-3 md:bottom-6 md:left-auto md:right-6 md:top-auto md:items-end">
        {items.map((t) => {
          const I = Icon[t.kind]
          return (
            <div key={t.id} className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-ink-700 bg-ink-850/95 p-3.5 shadow-2xl backdrop-blur animate-fade-up">
              <I className={cn('mt-0.5 h-5 w-5 shrink-0', t.kind === 'success' && 'text-lime', t.kind === 'error' && 'text-rose-400', t.kind === 'info' && 'text-sky-400')} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink-50">{t.title}</p>
                {t.description && <p className="mt-0.5 text-xs text-ink-300">{t.description}</p>}
              </div>
              <button onClick={() => setItems((s) => s.filter((x) => x.id !== t.id))} className="text-ink-400 hover:text-ink-100"><X className="h-4 w-4" /></button>
            </div>
          )
        })}
      </div>
    </ToastCtx.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastCtx)
  if (!ctx) throw new Error('useToast outside provider')
  return ctx.toast
}
