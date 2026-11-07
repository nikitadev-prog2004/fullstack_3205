import { z } from "zod";
import { ValidationError } from "../errors.js";
import type { Order, OrdersRepository } from "../repositories/orders.js";
import { parseRub, toKop } from "../utils/money.js";
import { parseUtc } from "../utils/time.js";

const Money = z.union([z.number(), z.string()]);

/** Заказ в формате внешнего API (поля, которые нам нужны; остальные игнорируем). */
const ExternalOrder = z.object({
  id: z.string().min(1),
  customerId: z.string().min(1),
  amount: Money,
  discountPercent: Money.optional(),
  amountPaid: Money.optional(),
  status: z.enum(["pending", "paid", "refunded"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Фактически оплаченное. amountPaid — источник истины, если он есть.
 * Иначе считаем из процента скидки. Нет обоих полей — скидки не было.
 */
function paidKop(amountRub: number, amountKop: number, discountPercent: unknown, amountPaid: unknown): number {
  if (amountPaid !== undefined) return toKop(parseRub(amountPaid));
  if (discountPercent === undefined) return amountKop;
  const percent = parseRub(discountPercent);
  if (percent > 100) throw new Error(`invalid discount: ${percent}`);
  return toKop(amountRub * (1 - percent / 100));
}

export type ApplyResult = "created" | "updated" | "stale";

export class OrdersService {
  constructor(private readonly orders: OrdersRepository) {}

  normalize(raw: unknown): Order {
    const parsed = ExternalOrder.safeParse(raw);
    if (!parsed.success) throw new ValidationError(`invalid order: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    const o = parsed.data;
    try {
      const amountRub = parseRub(o.amount);
      const amountKop = toKop(amountRub);
      return {
        id: o.id,
        customerId: o.customerId,
        amountKop,
        amountPaidKop: paidKop(amountRub, amountKop, o.discountPercent, o.amountPaid),
        status: o.status,
        createdAt: parseUtc(o.createdAt),
        updatedAt: parseUtc(o.updatedAt),
      };
    } catch (e) {
      throw new ValidationError((e as Error).message);
    }
  }

  /**
   * Применяет версию заказа (из синка или вебхука).
   * Вебхуки приходят с повторами, не по порядку и несколькими запросами сразу.
   * В базе остаётся запись с большим updatedAt; равная или более старая — stale.
   */
  async apply(raw: unknown): Promise<ApplyResult> {
    return this.orders.save(this.normalize(raw));
  }
}
