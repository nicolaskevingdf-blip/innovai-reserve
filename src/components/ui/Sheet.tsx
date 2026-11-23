import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Right-side drawer on desktop, bottom sheet on mobile. */
export function Sheet({ open, onClose, title, subtitle, children, footer, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'absolute flex flex-col border-ink-700 bg-ink-900 shadow-2xl',
          'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-3xl border-t animate-slide-in-up',
          'md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:rounded-none md:border-l md:border-t-0 md:animate-slide-in-right',
          wide ? 'md:w-[640px]' : 'md:w-[480px]',
        )}
      >
        <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-ink-600 md:hidden" />
        <div className="flex items-start justify-between gap-4 border-b border-ink-800 px-5 py-4 md:px-6 md:py-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-ink-50">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-ink-400">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="-mr-1 rounded-lg p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5 md:px-6">{children}</div>
        {footer && <div className="pb-safe border-t border-ink-800 bg-ink-900 px-5 pt-3 md:px-6 md:pb-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmDialog({ open, title, description, confirmLabel = 'Confirmar', danger, loading, onConfirm, onClose, children }: {
  open: boolean; title: string; description?: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean
  onConfirm: () => void; onClose: () => void; children?: ReactNode
}) {
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-end p-0 sm:place-items-center sm:p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-t-3xl border border-ink-700 bg-ink-900 p-6 shadow-2xl animate-fade-up sm:rounded-3xl">
        <h3 className="text-lg font-semibold">{title}</h3>
        {description && <div className="mt-2 text-sm text-ink-300">{description}</div>}
        {children && <div className="mt-4">{children}</div>}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button onClick={onClose} className="h-10 rounded-xl px-4 text-sm font-semibold text-ink-300 hover:bg-ink-800">Voltar</button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={cn('h-10 rounded-xl px-4 text-sm font-semibold disabled:opacity-50',
              danger ? 'bg-rose-500 text-white hover:bg-rose-400' : 'bg-lime text-ink-950 hover:bg-lime-400')}
          >
            {loading ? 'Aguarde…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
