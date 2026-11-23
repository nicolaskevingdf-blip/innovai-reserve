import { clsx, type ClassValue } from 'clsx'

export const cn = (...inputs: ClassValue[]) => clsx(inputs)

export const digits = (v: string) => v.replace(/\D/g, '')

/** Formats Brazilian phones progressively: (11) 98888-7777 */
export function formatPhone(value: string) {
  let d = digits(value)
  if (d.startsWith('55') && d.length > 11) d = d.slice(2)
  d = d.slice(0, 11)
  if (d.length <= 2) return d.length ? `(${d}` : ''
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
}

export const isValidPhone = (v: string) => {
  const d = digits(v)
  return d.length >= 10 && d.length <= 13
}

export const isValidEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)

export function slugify(v: string) {
  return v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export const formatMoney = (cents: number | null | undefined, currency = 'BRL') =>
  cents == null ? '' : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency })

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')

export function hexToRgbTriplet(hex: string) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return '198 244 50'
  return `${parseInt(m[1], 16)} ${parseInt(m[2], 16)} ${parseInt(m[3], 16)}`
}

/** Picks black or white text for a given background colour */
export function readableOn(hex: string) {
  const [r, g, b] = hexToRgbTriplet(hex).split(' ').map(Number)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? '#0B0B0D' : '#FFFFFF'
}

export const pct = (curr: number, prev: number) => (prev === 0 ? (curr === 0 ? 0 : null) : ((curr - prev) / prev) * 100)

export const whatsappLink = (phone: string, text?: string) => {
  let d = digits(phone)
  if (d.length <= 11) d = `55${d}`
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}
