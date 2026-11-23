import { cn } from '@/lib/utils'

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <div className="relative grid h-8 w-8 place-items-center rounded-[10px] bg-lime text-ink-950 shadow-[0_0_24px_-4px_rgba(198,244,50,0.6)]">
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 19V5" />
          <path d="M10 19V5l9 14V5" />
        </svg>
      </div>
      {!compact && (
        <div className="leading-none">
          <span className="font-display text-[15px] font-extrabold tracking-tight text-ink-50">innovai</span>
          <span className="ml-1 font-display text-[15px] font-medium tracking-tight text-lime">reserve</span>
        </div>
      )}
    </div>
  )
}
