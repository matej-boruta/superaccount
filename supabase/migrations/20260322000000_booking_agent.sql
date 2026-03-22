CREATE TABLE IF NOT EXISTS google_tokens (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  expires_at TIMESTAMPTZ,
  aktualizovano TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ucetni_vzory (
  id SERIAL PRIMARY KEY,
  ico TEXT,
  dodavatel TEXT,
  firma_id INTEGER,
  typ_dokladu TEXT NOT NULL,
  md_ucet TEXT NOT NULL,
  dal_ucet TEXT NOT NULL,
  md_dph TEXT,
  dal_dph TEXT,
  sazba_dph NUMERIC,
  stredisko TEXT,
  kategorie_id INTEGER,
  typ_platby TEXT,
  parovat_keyword TEXT,
  auto_schvalit BOOLEAN DEFAULT false,
  auto_parovat BOOLEAN DEFAULT false,
  confidence INTEGER DEFAULT 0,
  pocet_pouziti INTEGER DEFAULT 0,
  zdroj TEXT DEFAULT 'history',
  poznamka TEXT,
  aktualizovano TIMESTAMPTZ DEFAULT now(),
  UNIQUE(ico, firma_id, typ_dokladu)
);

CREATE TABLE IF NOT EXISTS ucetni_denik (
  id SERIAL PRIMARY KEY,
  datum DATE NOT NULL,
  duzp DATE,
  obdobi TEXT,
  typ_dokladu TEXT,
  doklad_ref TEXT,
  popis TEXT,
  md_ucet TEXT NOT NULL,
  dal_ucet TEXT NOT NULL,
  castka NUMERIC NOT NULL,
  castka_czk NUMERIC,
  mena TEXT DEFAULT 'CZK',
  kurz NUMERIC DEFAULT 1,
  stredisko TEXT,
  faktura_id INTEGER,
  transakce_id INTEGER,
  firma_id INTEGER,
  zauctoval TEXT DEFAULT 'agent',
  confidence INTEGER,
  schvaleno BOOLEAN DEFAULT false,
  chyba TEXT
);

CREATE TABLE IF NOT EXISTS smlouvy (
  id SERIAL PRIMARY KEY,
  ico TEXT,
  dodavatel TEXT,
  firma_id INTEGER,
  nazev TEXT,
  typ TEXT,
  frekvence TEXT,
  castka_fixni NUMERIC,
  mena TEXT DEFAULT 'CZK',
  ucetni_typ TEXT,
  vzor_id INTEGER,
  aktivni BOOLEAN DEFAULT true,
  poznamka TEXT,
  aktualizovano TIMESTAMPTZ DEFAULT now()
);
