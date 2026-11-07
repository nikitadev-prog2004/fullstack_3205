-- Фактически оплаченная сумма в копейках. Для старых заказов без скидки совпадает с amount_kop.
ALTER TABLE orders ADD COLUMN amount_paid_kop BIGINT;
UPDATE orders SET amount_paid_kop = amount_kop WHERE amount_paid_kop IS NULL;
ALTER TABLE orders ALTER COLUMN amount_paid_kop SET NOT NULL;
