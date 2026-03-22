-- ============================================================
-- BOOKING AGENT — znalostní báze sdílená napříč firmami
-- ============================================================

-- Účetní vzory per dodavatel (globální, sdílené)
-- Klíč = IČO dodavatele → platí pro všechny firmy
CREATE TABLE IF NOT EXISTS ucetni_vzory (
  id            SERIAL PRIMARY KEY,
  ico           TEXT,                    -- IČO dodavatele (hlavní klíč pro cross-company)
  dodavatel     TEXT,                    -- název (fallback pokud IČO neznáme)
  firma_id      INTEGER,                 -- NULL = globální, číslo = firma-specific override
  typ_dokladu   TEXT NOT NULL,           -- 'faktura', 'platba_karta', 'platba_prevod', 'dobropis', 'zaloha'
  md_ucet       TEXT NOT NULL,           -- má dáti
  dal_ucet      TEXT NOT NULL,           -- dal
  md_dph        TEXT,                    -- DPH má dáti (343)
  dal_dph       TEXT,                    -- DPH dal (321001)
  sazba_dph     NUMERIC,                 -- 0, 12, 21
  stredisko     TEXT,
  kategorie_id  INTEGER,
  typ_platby    TEXT,                    -- 'karta', 'prevod'
  parovat_keyword TEXT,                  -- keyword v bankovním výpisu
  auto_schvalit BOOLEAN DEFAULT false,
  auto_parovat  BOOLEAN DEFAULT false,
  confidence    INTEGER DEFAULT 0,       -- 0-100
  pocet_pouziti INTEGER DEFAULT 0,
  zdroj         TEXT DEFAULT 'history',  -- 'history', 'manual', 'cross_company'
  poznamka      TEXT,
  aktualizovano TIMESTAMPTZ DEFAULT now(),
  UNIQUE(ico, firma_id, typ_dokladu)
);

-- Smlouvy — vazba faktura ↔ smlouva ↔ účetní pravidlo
CREATE TABLE IF NOT EXISTS smlouvy (
  id            SERIAL PRIMARY KEY,
  ico           TEXT,
  dodavatel     TEXT,
  firma_id      INTEGER,
  nazev         TEXT,
  typ           TEXT,   -- 'sluzba', 'subscription', 'prepaid_kredit', 'najem', 'aktivum', 'dpp'
  frekvence     TEXT,   -- 'mesicni', 'rocni', 'nepravidelna'
  castka_fixni  NUMERIC,
  mena          TEXT DEFAULT 'CZK',
  ucetni_typ    TEXT,   -- 'prime_naklady', 'casove_rozliseni', 'zaloha', 'aktivum'
  vzor_id       INTEGER REFERENCES ucetni_vzory(id),
  aktivni       BOOLEAN DEFAULT true,
  poznamka      TEXT,
  aktualizovano TIMESTAMPTZ DEFAULT now()
);

-- Účetní deník — každý zaúčtovaný řádek agenta
CREATE TABLE IF NOT EXISTS ucetni_denik (
  id            SERIAL PRIMARY KEY,
  datum         DATE NOT NULL,
  duzp          DATE,
  obdobi        TEXT,                    -- '2026-03' (rok-mesic)
  typ_dokladu   TEXT,
  doklad_ref    TEXT,                    -- 'FP-35-2026', 'T-298'
  popis         TEXT,
  md_ucet       TEXT NOT NULL,
  dal_ucet      TEXT NOT NULL,
  castka        NUMERIC NOT NULL,
  castka_czk    NUMERIC,
  mena          TEXT DEFAULT 'CZK',
  kurz          NUMERIC DEFAULT 1,
  stredisko     TEXT,
  faktura_id    INTEGER,
  transakce_id  INTEGER,
  smlouva_id    INTEGER,
  firma_id      INTEGER,
  zauctoval     TEXT DEFAULT 'agent',    -- 'agent', 'manual'
  confidence    INTEGER,
  schvaleno     BOOLEAN DEFAULT false,
  chyba         TEXT                     -- pokud agent detekoval nesoulad
);

-- Pravidla pro kurzové přepočty (§24 odst. 7 ZoÚ)
CREATE TABLE IF NOT EXISTS kurzy (
  datum         DATE NOT NULL,
  mena          TEXT NOT NULL,
  kurz_czk      NUMERIC NOT NULL,
  zdroj         TEXT DEFAULT 'cnb',
  PRIMARY KEY(datum, mena)
);

-- Seed: základní předkontace dle českého účtového rozvrhu
-- (agent tyto zná jako zákonné minimum)
INSERT INTO ucetni_vzory (ico, dodavatel, typ_dokladu, md_ucet, dal_ucet, md_dph, dal_dph, sazba_dph, typ_platby, confidence, zdroj, poznamka)
VALUES
-- Seznam.cz — karetní platba, MKT výkon
('26168685', 'Seznam.cz, a.s.', 'platba_karta',  '518100', '221001', '343', '221001', 21, 'karta',  95, 'manual', 'DUZP = datum platby kartou (§21/5 ZDPH)'),
('26168685', 'Seznam.cz, a.s.', 'faktura',        '518100', '321001', '343', '321001', 21, 'karta',  95, 'manual', 'Platba kartou — FA potvrzuje již provedenou platbu'),
-- Google — karetní platba, IT produkt
(NULL,       'Google',          'platba_karta',  '518500', '221001', NULL,  NULL,     0,  'karta',  85, 'manual', 'Google Ads/Cloud — různé IČO, match dle keyword. Kurz ČNB ke dni DUZP'),
(NULL,       'Google',          'faktura',        '518500', '321001', NULL,  NULL,     0,  'karta',  85, 'manual', 'Reverse charge §108 odst.3 ZDPH — DPH odvede odběratel'),
-- DPP / OSVČ — osobní náklady
(NULL,       'DPP/OSVČ',        'faktura',        '521100', '321001', NULL,  NULL,     0,  'prevod', 70, 'manual', 'Bez DPH pokud OSVČ neplátce. Zkontrolovat DIČ.'),
-- Obecná faktura za služby
(NULL,       'DEFAULT_SLUZBA',  'faktura',        '518500', '321001', '343', '321001', 21, 'prevod', 50, 'manual', 'Výchozí předkontace — agent ověří dle kategorie'),
(NULL,       'DEFAULT_SLUZBA',  'platba_prevod',  '321001', '221001', NULL,  NULL,     0,  'prevod', 50, 'manual', 'Úhrada závazku z banky')
ON CONFLICT DO NOTHING;
