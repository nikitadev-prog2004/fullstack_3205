import { describe, expect, it } from "vitest";
import { apiOrder, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("POST /webhooks/order", () => {
  it("создаёт заказ", async () => {
    const res = await postWebhook(ctx.app, apiOrder());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: "created" });
  });

  it("повтор того же события ничего не меняет", async () => {
    const o = apiOrder();
    await postWebhook(ctx.app, o);
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
  });

  it("устаревшее событие после нового игнорируется", async () => {
    const o = apiOrder({ status: "paid", updatedAt: "2026-02-10T12:00:00Z" });
    await postWebhook(ctx.app, { ...o, status: "refunded", updatedAt: "2026-02-11T12:00:00Z" });
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
    const { rows } = await ctx.db.query(`SELECT status FROM orders WHERE id = $1`, [o.id]);
    expect(rows[0].status).toBe("refunded");
  });

  it("новое событие обновляет заказ", async () => {
    const o = apiOrder({ status: "pending" });
    await postWebhook(ctx.app, o);
    const res = await postWebhook(ctx.app, { ...o, status: "paid", updatedAt: "2026-02-11T00:00:00Z" });
    expect(res.json()).toEqual({ result: "updated" });
  });

  it("невалидное тело — 400", async () => {
    const res = await postWebhook(ctx.app, { id: "x" });
    expect(res.statusCode).toBe(400);
  });

  it("параллельные вебхуки не затирают более новую версию", async () => {
    await Promise.all(
      Array.from({ length: 15 }, async (_, i) => {
        const o = apiOrder({ id: `race_${i}`, status: "pending", updatedAt: "2026-02-10T10:00:00Z" });
        await Promise.all([
          postWebhook(ctx.app, { ...o, status: "paid", discountPercent: 10, amountPaid: 900, updatedAt: "2026-02-10T12:00:00Z" }),
          postWebhook(ctx.app, { ...o, status: "paid", discountPercent: 50, amountPaid: 500, updatedAt: "2026-02-10T14:00:00Z" }),
          postWebhook(ctx.app, { ...o, status: "refunded", discountPercent: 50, amountPaid: 500, updatedAt: "2026-02-10T13:00:00Z" }),
        ]);
      }),
    );
    const { rows } = await ctx.db.query(
      `SELECT count(*)::int AS n FROM orders WHERE id LIKE 'race_%' AND status = 'paid' AND amount_paid_kop = 50000`,
    );
    expect(rows[0].n).toBe(15);
  });
});
