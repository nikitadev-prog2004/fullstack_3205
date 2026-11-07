import { describe, expect, it } from "vitest";
import { apiOrder, dailyTotals, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("GET /customers/:id/daily-totals", () => {
  it("суммирует оплаченные заказы по дням в таймзоне клиента", async () => {
    // c_1 — Europe/Moscow (UTC+3): 20:30Z ещё 10-е, 21:30Z уже 11-е
    await postWebhook(ctx.app, apiOrder({ amount: 1000, createdAt: "2026-02-10T20:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: 250, createdAt: "2026-02-10T21:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: "99", createdAt: "2026-02-11T10:00:00Z" }));

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-09", "2026-02-11");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { date: "2026-02-09", total: 0, gross: 0, discount: 0, net: 0 },
      { date: "2026-02-10", total: 1000, gross: 1000, discount: 0, net: 1000 },
      { date: "2026-02-11", total: 349, gross: 349, discount: 0, net: 349 },
    ]);
  });

  it("не учитывает pending и refunded", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 700, status: "pending" }));
    await postWebhook(ctx.app, apiOrder({ amount: 900, status: "refunded" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 500, gross: 500, discount: 0, net: 500 }]);
  });

  it("учитывает только заказы этого клиента", async () => {
    ctx.api.customers.set("c_2", "Asia/Novosibirsk");
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 800, customerId: "c_2" }));
    const res = await dailyTotals(ctx.app, "c_2", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 800, gross: 800, discount: 0, net: 800 }]);
  });

  it("таймзона клиента берётся из API один раз", async () => {
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    ctx.api.customers.set("c_1", "UTC");
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    const { rows } = await ctx.db.query(`SELECT timezone FROM customers WHERE id = 'c_1'`);
    expect(rows[0].timezone).toBe("Europe/Moscow");
  });

  it("валидирует даты", async () => {
    expect((await dailyTotals(ctx.app, "c_1", "2026-02-30", "2026-03-01")).statusCode).toBe(400);
    expect((await dailyTotals(ctx.app, "c_1", "2026-03-02", "2026-03-01")).statusCode).toBe(400);
  });

  it("неизвестный клиент — 404", async () => {
    const res = await dailyTotals(ctx.app, "nobody", "2026-02-10", "2026-02-10");
    expect(res.statusCode).toBe(404);
  });

  it("считает gross, скидку и net по оплаченным заказам", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 2500, discountPercent: 16.5, amountPaid: 2087.5 }));
    await postWebhook(
      ctx.app,
      apiOrder({ amount: "100.00", discountPercent: "10", amountPaid: 90, createdAt: "2026-02-10T18:00:00Z" }),
    );
    await postWebhook(ctx.app, apiOrder({ amount: 500, discountPercent: 50, amountPaid: 250, status: "pending" }));

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 2600, gross: 2600, discount: 422.5, net: 2177.5 }]);
  });

  it("без полей скидки net равен gross, процент без amountPaid считает оплату", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 1000 }));
    await postWebhook(
      ctx.app,
      apiOrder({ amount: 200, discountPercent: "25", createdAt: "2026-02-10T15:00:00Z" }),
    );

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 1200, gross: 1200, discount: 50, net: 1150 }]);
  });

  it("в статистику попадает последняя версия оплаты, устаревший вебхук её не затирает", async () => {
    const o = apiOrder({ amount: 1000, discountPercent: 10, amountPaid: 900, updatedAt: "2026-02-10T12:00:00Z" });
    await postWebhook(ctx.app, o);
    await postWebhook(ctx.app, { ...o, discountPercent: 25, amountPaid: 750, updatedAt: "2026-02-10T13:00:00Z" });
    await postWebhook(ctx.app, { ...o, discountPercent: 0, amountPaid: 1000, updatedAt: "2026-02-10T11:00:00Z" });

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 1000, gross: 1000, discount: 250, net: 750 }]);
  });

  it("не теряет копейку на суммах, которые двоичная дробь уводит чуть ниже целого", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 4723.9, amountPaid: 4723.9 }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 4723.9, gross: 4723.9, discount: 0, net: 4723.9 }]);
  });

  it("день заказа — в таймзоне клиента на момент createdAt, включая перевод часов", async () => {
    // Europe/Berlin: до 2026-03-29 01:00Z это CET (UTC+1), после — CEST (UTC+2).
    // Одно смещение «на сейчас» не может правильно разложить оба заказа.
    ctx.api.customers.set("c_berlin", "Europe/Berlin");
    await postWebhook(
      ctx.app,
      apiOrder({
        customerId: "c_berlin",
        amount: 100,
        createdAt: "2026-03-28T22:40:00Z",
        updatedAt: "2026-03-28T22:40:00Z",
      }),
    );
    await postWebhook(
      ctx.app,
      apiOrder({
        customerId: "c_berlin",
        amount: 200,
        createdAt: "2026-03-29T22:40:00Z",
        updatedAt: "2026-03-29T22:40:00Z",
      }),
    );
    // 31.03 22:40Z — уже 01.04 в Берлине, в диапазон 27–31 не входит
    await postWebhook(
      ctx.app,
      apiOrder({
        customerId: "c_berlin",
        amount: 400,
        createdAt: "2026-03-31T22:40:00Z",
        updatedAt: "2026-03-31T22:40:00Z",
      }),
    );

    const res = await dailyTotals(ctx.app, "c_berlin", "2026-03-27", "2026-03-31");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { date: "2026-03-27", total: 0, gross: 0, discount: 0, net: 0 },
      { date: "2026-03-28", total: 100, gross: 100, discount: 0, net: 100 },
      { date: "2026-03-29", total: 0, gross: 0, discount: 0, net: 0 },
      { date: "2026-03-30", total: 200, gross: 200, discount: 0, net: 200 },
      { date: "2026-03-31", total: 0, gross: 0, discount: 0, net: 0 },
    ]);
  });
});
