CREATE TABLE IF NOT EXISTS sales (
  token TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  payment_id TEXT,
  preference_id TEXT,
  approved_at INTEGER,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sales_payment_id ON sales(payment_id);
