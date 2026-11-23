import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz'
import { ptBR } from 'date-fns/locale'
import { addDays, startOfWeek, startOfMonth, endOfMonth, endOfWeek, eachDayOfInterval, format } from 'date-fns'

/**
 * All instants are stored as timestamptz (UTC). Everything shown to people is
 * rendered in the establishment's timezone — never the browser's.
 */
export const fmt = (iso: string | Date, tz: string, pattern: string) =>
  formatInTimeZone(typeof iso === 'string' ? new Date(iso) : iso, tz, pattern, { locale: ptBR })

export const fmtTime = (iso: string, tz: string) => fmt(iso, tz, 'HH:mm')
export const fmtDate = (iso: string, tz: string) => fmt(iso, tz, 'dd/MM/yyyy')
export const fmtDateLong = (iso: string | Date, tz: string) => fmt(iso, tz, "EEEE, d 'de' MMMM")
export const fmtDateTime = (iso: string, tz: string) => fmt(iso, tz, "dd/MM/yyyy 'às' HH:mm")

/** "yyyy-MM-dd" of an instant in the tenant timezone */
export const localDateKey = (iso: string | Date, tz: string) => fmt(iso, tz, 'yyyy-MM-dd')

/** today's date key in the tenant timezone */
export const todayKey = (tz: string) => localDateKey(new Date(), tz)

/** wall-clock date + time in the tenant tz → UTC ISO string */
export const zonedToUtcIso = (dateKey: string, time: string, tz: string) =>
  fromZonedTime(`${dateKey}T${time.length === 5 ? `${time}:00` : time}`, tz).toISOString()

/** start/end instants (ISO) of a local day range [from, to] in tenant tz */
export const dayRangeUtc = (fromKey: string, toKey: string, tz: string) => ({
  from: fromZonedTime(`${fromKey}T00:00:00`, tz).toISOString(),
  to: fromZonedTime(`${shiftKey(toKey, 1)}T00:00:00`, tz).toISOString(),
})

/** date keys are handled as plain calendar dates (noon avoids DST edges) */
export const keyToDate = (key: string) => new Date(`${key}T12:00:00`)
export const dateToKey = (d: Date) => format(d, 'yyyy-MM-dd')
export const shiftKey = (key: string, days: number) => dateToKey(addDays(keyToDate(key), days))

export const weekKeys = (key: string) => {
  const start = startOfWeek(keyToDate(key), { weekStartsOn: 1 })
  return Array.from({ length: 7 }, (_, i) => dateToKey(addDays(start, i)))
}

export const monthGridKeys = (key: string) => {
  const d = keyToDate(key)
  return eachDayOfInterval({
    start: startOfWeek(startOfMonth(d), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(d), { weekStartsOn: 1 }),
  }).map(dateToKey)
}

export const keyLabel = (key: string, pattern: string) => format(keyToDate(key), pattern, { locale: ptBR })

export const minutesOfDay = (iso: string, tz: string) => {
  const z = toZonedTime(new Date(iso), tz)
  return z.getHours() * 60 + z.getMinutes()
}

export const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
export const WEEKDAYS_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

export const greeting = (tz: string) => {
  const h = Number(fmt(new Date(), tz, 'H'))
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'
}

export const TIMEZONES = [
  'America/Sao_Paulo', 'America/Manaus', 'America/Belem', 'America/Fortaleza', 'America/Recife',
  'America/Bahia', 'America/Cuiaba', 'America/Campo_Grande', 'America/Porto_Velho', 'America/Rio_Branco',
  'America/Noronha', 'America/Boa_Vista', 'Europe/Lisbon', 'America/Argentina/Buenos_Aires', 'America/Santiago',
  'America/Bogota', 'America/Mexico_City', 'America/New_York', 'UTC',
]
