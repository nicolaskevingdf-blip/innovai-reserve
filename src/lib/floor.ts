import type { DiningTable, Reservation, ScheduleBlock } from '@/types/db'

/** Visual status of a table at a given instant (spec: verde/amarelo/vermelho/azul/cinza). */
export type TableStatus = 'available' | 'reserved' | 'occupied' | 'arriving' | 'unavailable'

export const TABLE_STATUS: Record<TableStatus, { label: string; fill: string; ring: string; text: string; dot: string }> = {
  available: { label: 'Disponível', fill: 'bg-emerald-500/15', ring: 'border-emerald-400/70', text: 'text-emerald-200', dot: 'bg-emerald-400' },
  reserved: { label: 'Reservada', fill: 'bg-amber-400/15', ring: 'border-amber-400/80', text: 'text-amber-200', dot: 'bg-amber-400' },
  occupied: { label: 'Ocupada', fill: 'bg-rose-500/20', ring: 'border-rose-400/80', text: 'text-rose-200', dot: 'bg-rose-400' },
  arriving: { label: 'Chegada aguardada', fill: 'bg-sky-500/20', ring: 'border-sky-400/80', text: 'text-sky-200', dot: 'bg-sky-400' },
  unavailable: { label: 'Indisponível', fill: 'bg-ink-700/50', ring: 'border-ink-500', text: 'text-ink-400', dot: 'bg-ink-400' },
}

export const STATUS_ORDER_FLOOR: TableStatus[] = ['available', 'reserved', 'arriving', 'occupied', 'unavailable']

const ARRIVAL_WINDOW_MS = 30 * 60_000

export interface TableState {
  status: TableStatus
  current?: Reservation
  next?: Reservation
  today: Reservation[]
  block?: ScheduleBlock
}

/**
 * - unavailable: table inactive or blocked now
 * - occupied: a checked-in (in_progress) reservation covers the instant
 * - arriving: a pending/confirmed reservation covers the instant or starts within 30 min
 * - reserved: another active reservation later in the day
 * - available: otherwise
 */
export function tableState(table: DiningTable, reservations: Reservation[], blocks: ScheduleBlock[], at: Date): TableState {
  const t = at.getTime()
  const mine = reservations
    .filter((r) => r.table_ids?.includes(table.id) && r.status !== 'cancelled' && r.status !== 'no_show')
    .sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at))
  const block = blocks.find((b) => (b.table_id === table.id || (!b.table_id && !b.staff_id)) && +new Date(b.starts_at) <= t && +new Date(b.ends_at) > t)
  const covering = mine.find((r) => +new Date(r.starts_at) <= t && +new Date(r.ends_at) > t && r.status !== 'completed')
  const upcoming = mine.find((r) => +new Date(r.starts_at) > t && (r.status === 'pending' || r.status === 'confirmed'))

  if (!table.is_active || block) return { status: 'unavailable', block, today: mine, next: upcoming }
  if (covering?.status === 'in_progress') return { status: 'occupied', current: covering, next: upcoming, today: mine }
  if (covering) return { status: 'arriving', current: covering, next: upcoming, today: mine }
  // checked-in party still seated after the planned end
  const overstay = mine.find((r) => r.status === 'in_progress' && +new Date(r.starts_at) <= t)
  if (overstay) return { status: 'occupied', current: overstay, next: upcoming, today: mine }
  if (upcoming && +new Date(upcoming.starts_at) - t <= ARRIVAL_WINDOW_MS) return { status: 'arriving', next: upcoming, current: upcoming, today: mine }
  if (upcoming) return { status: 'reserved', next: upcoming, today: mine }
  return { status: 'available', today: mine }
}

export const tableLabel = (ids: string[] | undefined, tables: DiningTable[]) =>
  (ids ?? []).map((id) => tables.find((t) => t.id === id)?.name ?? '—').join(' + ')
