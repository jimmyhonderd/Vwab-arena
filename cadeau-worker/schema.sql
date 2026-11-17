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
CREATE TABLE IF NOT EXISTS items (
  list TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (list, id)
);
CREATE TABLE IF NOT EXISTS hidden (
  list TEXT NOT NULL,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (list, id)
);
