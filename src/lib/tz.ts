// BRT timezone helpers. Brasil aboliu DST em 2019 — offset fixo UTC-3.
// NÃO confiar em Date.getHours() / setHours() (local do servidor).
// Sempre usar estas funções quando comparar ou agendar em hora brasileira.

const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Hora atual em BRT, 0-23. */
export function currentHourBRT(): number {
  const now = new Date();
  return (now.getUTCHours() + 24 - 3) % 24;
}

/**
 * Retorna um Date (em tempo real UTC) que corresponde ao próximo
 * horário hourBRT:00 no fuso São Paulo. Se já passou hoje, avança 1 dia.
 */
export function nextHourBRT(hourBRT: number): Date {
  const now = new Date();
  const nowBrt = new Date(now.getTime() + BRT_OFFSET_MS);
  const targetBrt = new Date(nowBrt);
  targetBrt.setUTCHours(hourBRT, 0, 0, 0);
  if (targetBrt.getTime() <= nowBrt.getTime()) {
    targetBrt.setUTCDate(targetBrt.getUTCDate() + 1);
  }
  return new Date(targetBrt.getTime() - BRT_OFFSET_MS);
}

/** YYYY-MM-DD no fuso BRT a partir de um Date UTC. */
export function dateStringBRT(d: Date = new Date()): string {
  const brt = new Date(d.getTime() + BRT_OFFSET_MS);
  return brt.toISOString().slice(0, 10);
}

/** Hora do dia (0-23) no fuso BRT a partir de um Date UTC. */
export function hourBRTFromDate(d: Date): number {
  const brt = new Date(d.getTime() + BRT_OFFSET_MS);
  return brt.getUTCHours();
}

function parseBrtDateParts(value: string): { year: number; month: number; day: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const [, yearRaw, monthRaw, dayRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function startOfBRTDay(input: Date = new Date()): Date {
  const brt = new Date(input.getTime() + BRT_OFFSET_MS);
  brt.setUTCHours(0, 0, 0, 0);
  return new Date(brt.getTime() - BRT_OFFSET_MS);
}

export function endOfBRTDay(input: Date = new Date()): Date {
  return new Date(startOfBRTDay(input).getTime() + DAY_MS - 1);
}

export function addBRTDays(input: Date, days: number): Date {
  return new Date(input.getTime() + days * DAY_MS);
}

export function parseBRTDateStart(value: string): Date | null {
  const parts = parseBrtDateParts(value);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 3, 0, 0, 0));
}

export function parseBRTDateEnd(value: string): Date | null {
  const start = parseBRTDateStart(value);
  if (!start) return null;
  return new Date(start.getTime() + DAY_MS - 1);
}

export function brtRangeFromStrings(
  dateFrom?: string,
  dateTo?: string
): { gte?: Date; lte?: Date } {
  const range: { gte?: Date; lte?: Date } = {};
  if (dateFrom) {
    const start = parseBRTDateStart(dateFrom);
    if (start) range.gte = start;
  }
  if (dateTo) {
    const end = parseBRTDateEnd(dateTo);
    if (end) range.lte = end;
  }
  return range;
}
