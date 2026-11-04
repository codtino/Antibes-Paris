-- Base D1 du serveur TGV Max
CREATE TABLE IF NOT EXISTS devices (
  endpoint TEXT PRIMARY KEY,
  p256dh   TEXT NOT NULL,
  auth     TEXT NOT NULL,
  label    TEXT,
  created  TEXT,
  last_ok  TEXT
);

-- Trajets surveillés. mode = 'aller' (o → d) ou 'ar' (les deux sens + allers-retours)
CREATE TABLE IF NOT EXISTS watches (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  o TEXT NOT NULL, o_name TEXT NOT NULL,
  d TEXT NOT NULL, d_name TEXT NOT NULL,
  mode      TEXT NOT NULL DEFAULT 'ar',
  days      TEXT NOT NULL DEFAULT '0123456',   -- jours de la semaine acceptés (0 = lundi)
  h_min     TEXT NOT NULL DEFAULT '00:00',
  h_max     TEXT NOT NULL DEFAULT '23:59',
  date_from TEXT,
  date_to   TEXT,
  stay_min  INTEGER NOT NULL DEFAULT 1,
  stay_max  INTEGER NOT NULL DEFAULT 7,
  active    INTEGER NOT NULL DEFAULT 1,
  created   TEXT
);

-- Dates ciblées : surveillance chaque minute et alerte prioritaire
CREATE TABLE IF NOT EXISTS targets (
  watch_id INTEGER NOT NULL,
  date     TEXT NOT NULL,
  PRIMARY KEY (watch_id, date)
);

-- Ce qui était disponible au dernier passage (pour ne notifier que les nouveautés)
CREATE TABLE IF NOT EXISTS seen (
  watch_id INTEGER NOT NULL,
  k        TEXT NOT NULL,
  PRIMARY KEY (watch_id, k)
);

-- Historique : une ligne par train et par publication SNCF
CREATE TABLE IF NOT EXISTS obs (
  snap  TEXT NOT NULL,
  od    TEXT NOT NULL,
  date  TEXT NOT NULL,
  train TEXT NOT NULL,
  dep   TEXT,
  arr   TEXT,
  libre INTEGER NOT NULL,
  PRIMARY KEY (od, snap, date, train)
);

-- Trains réservés : rappels de confirmation J-2 / J-1
CREATE TABLE IF NOT EXISTS trips (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  date   TEXT NOT NULL,
  dep    TEXT NOT NULL,
  arr    TEXT,
  train  TEXT,
  o_name TEXT,
  d_name TEXT,
  r1     INTEGER NOT NULL DEFAULT 0,
  r2     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
