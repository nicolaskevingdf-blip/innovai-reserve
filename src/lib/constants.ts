import type { ReservationSource, ReservationStatus, Segment, MemberRole, NotificationStatus } from '@/types/db'

export const STATUS: Record<ReservationStatus, { label: string; chip: string; dot: string; bar: string }> = {
  pending: { label: 'Pendente', chip: 'border-amber-400/30 bg-amber-400/10 text-amber-300', dot: 'bg-amber-400', bar: 'border-l-amber-400 bg-amber-400/[0.07]' },
  confirmed: { label: 'Confirmada', chip: 'border-lime/30 bg-lime/10 text-lime', dot: 'bg-lime', bar: 'border-l-lime bg-lime/[0.07]' },
  in_progress: { label: 'Em andamento', chip: 'border-sky-400/30 bg-sky-400/10 text-sky-300', dot: 'bg-sky-400', bar: 'border-l-sky-400 bg-sky-400/[0.08]' },
  completed: { label: 'Concluída', chip: 'border-ink-500 bg-ink-700/60 text-ink-200', dot: 'bg-ink-300', bar: 'border-l-ink-400 bg-ink-700/40' },
  cancelled: { label: 'Cancelada', chip: 'border-rose-400/30 bg-rose-400/10 text-rose-300', dot: 'bg-rose-400', bar: 'border-l-rose-400 bg-rose-400/[0.06] opacity-60' },
  no_show: { label: 'Não compareceu', chip: 'border-orange-400/30 bg-orange-400/10 text-orange-300', dot: 'bg-orange-400', bar: 'border-l-orange-400 bg-orange-400/[0.06] opacity-70' },
}

export const STATUS_ORDER: ReservationStatus[] = ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show']
export const ACTIVE_STATUSES: ReservationStatus[] = ['pending', 'confirmed', 'in_progress']

/** allowed manual transitions (keeps the agenda consistent) */
export const NEXT_STATUS: Record<ReservationStatus, ReservationStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['in_progress', 'no_show', 'cancelled', 'pending'],
  in_progress: ['completed', 'confirmed'],
  completed: ['in_progress'],
  cancelled: ['confirmed'],
  no_show: ['confirmed'],
}

export const SOURCE: Record<ReservationSource, string> = {
  online: 'Online', manual: 'Manual', phone: 'Telefone', walk_in: 'Presencial', whatsapp: 'WhatsApp', instagram: 'Instagram',
}

export const SEGMENT: Record<Segment, { label: string; path: string; unit: string; unitPlural: string; partyLabel: string }> = {
  restaurant: { label: 'Restaurante', path: 'restaurante', unit: 'reserva', unitPlural: 'reservas', partyLabel: 'Pessoas' },
  barbershop: { label: 'Barbearia', path: 'barbearia', unit: 'agendamento', unitPlural: 'agendamentos', partyLabel: 'Pessoas' },
  salon: { label: 'Salão de beleza', path: 'salao', unit: 'agendamento', unitPlural: 'agendamentos', partyLabel: 'Pessoas' },
  clinic: { label: 'Clínica / Estética', path: 'clinica', unit: 'agendamento', unitPlural: 'agendamentos', partyLabel: 'Pessoas' },
  other: { label: 'Outro', path: 'estabelecimento', unit: 'reserva', unitPlural: 'reservas', partyLabel: 'Pessoas' },
}

/** Portuguese gender agreement: "Nova reserva" / "Novo agendamento" */
export const newUnit = (segment: Segment) => (SEGMENT[segment].unit === 'reserva' ? 'Nova reserva' : 'Novo agendamento')
export const noneUnit = (segment: Segment) => (SEGMENT[segment].unit === 'reserva' ? 'Nenhuma reserva' : 'Nenhum agendamento')

export const SEGMENT_PATHS = Object.values(SEGMENT).map((s) => s.path)

export const ROLE: Record<MemberRole, string> = { owner: 'Proprietário', manager: 'Gerente', staff: 'Funcionário' }

export const NOTIFICATION_STATUS: Record<NotificationStatus, { label: string; chip: string }> = {
  pending: { label: 'Na fila', chip: 'border-amber-400/30 bg-amber-400/10 text-amber-300' },
  sent: { label: 'Enviada', chip: 'border-lime/30 bg-lime/10 text-lime' },
  failed: { label: 'Falhou', chip: 'border-rose-400/30 bg-rose-400/10 text-rose-300' },
  skipped: { label: 'Ignorada', chip: 'border-ink-500 bg-ink-700/60 text-ink-300' },
  requires_setup: { label: 'Requer configuração', chip: 'border-sky-400/30 bg-sky-400/10 text-sky-300' },
  cancelled: { label: 'Cancelada', chip: 'border-ink-500 bg-ink-700/60 text-ink-300' },
}

export const TEMPLATE_LABEL: Record<string, string> = {
  reservation_received: 'Reserva recebida',
  reservation_confirmed: 'Confirmação',
  reservation_cancelled: 'Cancelamento',
  reservation_rescheduled: 'Alteração',
  reminder: 'Lembrete',
  review_request: 'Pedido de avaliação',
  staff_new_reservation: 'Nova reserva',
  staff_reservation_cancelled: 'Cancelamento',
  staff_reservation_rescheduled: 'Remarcação',
}
