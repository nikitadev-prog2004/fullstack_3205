/**
 * Деньги внутри сервиса — целые копейки. Рубли — только на входе (внешний API) и в ответах.
 */

/** Сумма из внешнего API: число или строка с числом ("250.10"). */
export function parseRub(raw: unknown): number {
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid amount: ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Рубли → копейки. Доля копейки отбрасывается: деньги клиенту не досчитываем.
 * Погрешность двоичной дроби (19.99 * 100 === 1998.9999999999998) копейкой не является —
 * значение, которое почти совпало с целой копейкой, приводим к ней.
 */
export function toKop(rub: number): number {
  const scaled = rub * 100;
  const nearest = Math.round(scaled);
  if (Math.abs(scaled - nearest) < 1e-6) return nearest;
  return Math.floor(scaled);
}

/** Копейки → рубли для ответа API, без хвоста двоичной дроби. */
export function fromKop(kop: number): number {
  return Number((kop / 100).toFixed(2));
}
