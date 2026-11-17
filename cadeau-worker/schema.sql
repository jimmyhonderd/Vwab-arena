CREATE TABLE IF NOT EXISTS claims (
  list TEXT NOT NULL,
  item TEXT NOT NULL,
  name TEXT,
  token TEXT NOT NULL,
  ip TEXT,
  ts INTEGER NOT NULL,
  PRIMARY KEY (list, item)
);
CREATE INDEX IF NOT EXISTS claims_ip_ts ON claims (ip, ts);
