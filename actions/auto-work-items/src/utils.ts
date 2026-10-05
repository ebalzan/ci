export function parseCsv(value?: string): string[] {
  if (!value) return []

  return value
    .split(/[\n,;]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

export function parseJsonMap(
  value: string | undefined,
  warn: (message: string) => void,
  variableName: string = 'AUTO_PRIORITY_MAP_JSON',
): Record<string, string> {
  if (!value) return {}

  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) return {}

    const mapped: Record<string, string> = {}
    for (const [key, rawValue] of Object.entries(parsed)) {
      if (typeof rawValue === 'string') {
        mapped[key] = rawValue
      }
    }
    return mapped
  } catch (error: unknown) {
    const message = getErrorMessage(error)
    warn(`Invalid ${variableName}, ignoring. ${message}`)
    return {}
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function getErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined
  return typeof error.status === 'number' ? error.status : undefined
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function getErrorList(error: unknown): unknown[] {
  if (!isRecord(error)) return []
  return Array.isArray(error.errors) ? error.errors : []
}

// An unset variable arrives as '' (auto-work-items.yml wires every AUTO_* from
// `vars`), and Number('') is 0 — so blank must mean "use the fallback".
export function asDateOffset(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function toISODate(date: Date): string {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

export function normalizeScope(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
}
