-- ============================================================
-- NOVÉ TABULKY — SuperAccount agent v2
-- Migrace: 2026-03-31
-- ============================================================

-- ------------------------------------------------------------
-- agent_api
-- Registr všech API přístupů agenta.
-- Agent sem zapisuje při každém připojení, aktualizuje stav
-- a pravidelně kontroluje dostupnost.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_api (
  id            SERIAL PRIMARY KEY,
  klic          TEXT UNIQUE NOT NULL,       -- 'abra', 'supabase', 'fio_czk1', 'google', 'n8n', 'claude'
  nazev         TEXT NOT NULL,
  typ           TEXT NOT NULL,              -- 'rest_api', 'oauth2', 'postgres', 'mcp'
  base_url      TEXT,                       -- základní URL endpointu
  auth_typ      TEXT,                       -- 'basic_env', 'bearer_env', 'api_key_env', 'oauth2_db', 'none'
  env_vars      JSONB,                      -- {"url": "ABRA_URL", "user": "ABRA_USER", "pass": "ABRA_PASS"}
  operace       JSONB,                      -- ["faktura-prijata", "banka", "adresar"]
  stav          TEXT DEFAULT 'neznamy',     -- 'ok', 'chyba', 'neznamy', 'degradovany'
  posledni_check TIMESTAMPTZ,
  posledni_chyba TEXT,
  response_time_ms INTEGER,
  aktivni       BOOLEAN DEFAULT true,
  poznamka      TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- ucetni_pravidla
-- Jediná tabulka pro VŠECHNA účetní pravidla systému.
-- Nahrazuje: ucetni_vzory, dodavatel_pravidla.
-- Pokrývá: předkontace, párování, kurzy, smlouvy, DPH, schválení.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ucetni_pravidla (
  id              SERIAL PRIMARY KEY,
  typ             TEXT NOT NULL,             -- viz níže
  -- Identifikace subjektu (alespoň jedno musí být vyplněno)
  ico             TEXT,                      -- IČO dodavatele — přesná shoda, nejvyšší priorita
  dodavatel_pattern TEXT,                    -- ILIKE pattern, fallback za ICO
  firma_id        INTEGER,                   -- NULL = globální pro všechny firmy holdingu
  -- Účetní předkontace
  md_ucet         TEXT,                      -- Má dáti
  dal_ucet        TEXT,                      -- Dal
  md_dph          TEXT,                      -- DPH Má dáti (343)
  dal_dph         TEXT,                      -- DPH Dal (321001)
  sazba_dph       NUMERIC,                   -- 0, 12, 21 (procenta)
  typ_dokladu     TEXT,                      -- 'faktura', 'platba_karta', 'platba_prevod', 'dobropis', 'zaloha', 'interní'
  typ_platby      TEXT,                      -- 'karta', 'prevod'
  stredisko       TEXT,                      -- účetní středisko
  -- Párování plateb
  parovat_keyword TEXT,                      -- keyword v bankovním výpisu (ILIKE)
  auto_schvalit   BOOLEAN DEFAULT false,
  auto_parovat    BOOLEAN DEFAULT false,
  limit_auto_kc   NUMERIC DEFAULT 50000,     -- max. částka pro auto-schválení (Kč)
  -- Smlouvy a opakující se platby
  frekvence       TEXT,                      -- 'mesicni', 'rocni', 'nepravidelna', 'jednorizova'
  castka_fixni    NUMERIC,                   -- fixní částka smlouvy (pro detekci odchylek)
  mena            TEXT DEFAULT 'CZK',
  -- Kurzové účtování
  kurz_zdroj      TEXT,                      -- 'cnb_denni', 'cnb_mesicni', 'pevny'
  -- Platnost pravidla
  platnost_od     DATE,
  platnost_do     DATE,
  -- Kvalita pravidla
  confidence      INTEGER DEFAULT 95,        -- 0-100 (95 = manuální, <85 = z historie)
  zdroj           TEXT DEFAULT 'manual',     -- 'manual', 'agent', 'history', 'cross_company'
  pocet_pouziti   INTEGER DEFAULT 0,
  -- Meta
  poznamka        TEXT,
  aktivni         BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Typy pravidel (typ column):
--   'predkontace'   — MD/DAL účty pro daný typ dokladu a dodavatele
--   'parovani'      — pravidla pro párování plateb s fakturami
--   'schvaleni'     — pravidla pro auto-schválení
--   'smlouva'       — opakující se závazek (subscription, nájem, DPP)
--   'fx_kurz'       — pravidlo pro kurzové přepočty (zdroj kurzu, účtování rozdílů)
--   'dph'           — specifická DPH pravidla (reverse charge, osvobození)
--   'casove_rozliseni' — pravidla pro časové rozlišení (381/383)
--   'zaloha'        — pravidla pro zálohy a jejich zúčtování

CREATE INDEX IF NOT EXISTS ucetni_pravidla_ico_idx ON ucetni_pravidla (ico) WHERE ico IS NOT NULL;
CREATE INDEX IF NOT EXISTS ucetni_pravidla_typ_idx ON ucetni_pravidla (typ);
CREATE INDEX IF NOT EXISTS ucetni_pravidla_pattern_idx ON ucetni_pravidla (dodavatel_pattern) WHERE dodavatel_pattern IS NOT NULL;
CREATE INDEX IF NOT EXISTS ucetni_pravidla_aktivni_idx ON ucetni_pravidla (aktivni, typ);

-- ------------------------------------------------------------
-- mng_kategorie
-- Manažerské kategorie — vrstva nad účetními daty.
-- Mapuje: analytický účet + středisko + dodavatel → manažerská kategorie.
-- Slouží pro reporty, dashboard, cash flow výhledy.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mng_kategorie (
  id              SERIAL PRIMARY KEY,
  nazev           TEXT NOT NULL,             -- 'Google Ads', 'Infrastruktura cloud', 'Mzdy a DPP'
  popis           TEXT,
  -- Analytický klíč — co přiřazuje faktura/transakci do kategorie
  ucetni_ucet     TEXT,                      -- konkrétní MD účet (518500, 521100, 548100...)
  stredisko       TEXT,                      -- středisko (IT-PRD, MARKETING, REZIJE...)
  dodavatel_pattern TEXT,                    -- volitelné zpřesnění: ILIKE pattern dodavatele
  ico             TEXT,                      -- volitelné zpřesnění: přesné IČO
  firma_id        INTEGER,                   -- NULL = všechny firmy holdingu
  -- Hierarchie kategorií (pro drill-down v reportech)
  parent_id       INTEGER REFERENCES mng_kategorie(id),
  -- Typ kategorie
  typ             TEXT DEFAULT 'naklady',    -- 'naklady', 'vynosy', 'aktivum', 'zavazek', 'cash', 'invest'
  -- Reporting
  rozpocet_mesicni NUMERIC,                 -- měsíční rozpočet (pro variance report)
  mena            TEXT DEFAULT 'CZK',
  -- Meta
  aktivni         BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mng_kategorie_ucet_idx ON mng_kategorie (ucetni_ucet) WHERE ucetni_ucet IS NOT NULL;
CREATE INDEX IF NOT EXISTS mng_kategorie_parent_idx ON mng_kategorie (parent_id) WHERE parent_id IS NOT NULL;

-- ============================================================
-- SEED: agent_api — registr všech přístupů
-- ============================================================
INSERT INTO agent_api (klic, nazev, typ, auth_typ, env_vars, operace, stav, poznamka)
VALUES
  ('abra', 'ABRA FlexiBee', 'rest_api', 'basic_env',
   '{"url": "ABRA_URL", "user": "ABRA_USER", "pass": "ABRA_PASS"}',
   '["faktura-prijata", "banka", "adresar", "mena", "pokladna"]',
   'neznamy', 'Hlavní účetní systém. Endpoint /status.json pro health check.'),

  ('supabase', 'Supabase', 'postgres', 'bearer_env',
   '{"url": "NEXT_PUBLIC_SUPABASE_URL", "key": "SUPABASE_SERVICE_KEY"}',
   '["faktury", "transakce", "kategorie", "agent_api", "agent_log", "ucetni_pravidla", "ucetni_denik", "mng_kategorie", "smlouvy", "kurzy", "google_tokens"]',
   'ok', 'Primární databáze. REST API + přímé PostgreSQL přes N8N.'),

  ('fio_czk1', 'Fio Banka CZK1', 'rest_api', 'api_key_env',
   '{"token": "FIO_TOKEN_CZK1"}',
   '["last_transactions", "by_id", "by_date"]',
   'neznamy', 'Hlavní CZK účet. Rate limit 1 req/30s. Technický dluh: token natvrdo v kódu — přesunout do env.'),

  ('fio_czk2', 'Fio Banka CZK2', 'rest_api', 'api_key_env',
   '{"token": "FIO_TOKEN_CZK2"}',
   '["last_transactions", "by_id", "by_date"]',
   'neznamy', 'Druhý CZK účet.'),

  ('fio_eur', 'Fio Banka EUR', 'rest_api', 'api_key_env',
   '{"token": "FIO_TOKEN_EUR"}',
   '["last_transactions", "by_id", "by_date"]',
   'neznamy', 'EUR účet. Kurzové rozdíly přes 261/563/663.'),

  ('fio_usd', 'Fio Banka USD', 'rest_api', 'api_key_env',
   '{"token": "FIO_TOKEN_USD"}',
   '["last_transactions", "by_id", "by_date"]',
   'neznamy', 'USD účet.'),

  ('google', 'Google APIs', 'oauth2', 'oauth2_db',
   '{"client_id": "GOOGLE_CLIENT_ID", "client_secret": "GOOGLE_CLIENT_SECRET", "token_table": "google_tokens"}',
   '["gmail.messages", "drive.files", "ads.invoices", "ads.api"]',
   'neznamy', 'OAuth tokeny v tabulce google_tokens. Refresh automatický.'),

  ('n8n', 'N8N Automation', 'rest_api', 'api_key_env',
   '{"url": "N8N_URL", "key": "N8N_API_KEY"}',
   '["workflow.trigger", "workflow.status", "workflow.create", "credentials.list"]',
   'ok', 'Orchestrátor automatizací a PostgreSQL proxy pro DDL operace.'),

  ('claude', 'Anthropic Claude', 'rest_api', 'bearer_env',
   '{"key": "ANTHROPIC_API_KEY"}',
   '["messages"]',
   'neznamy', 'AI inference. Haiku pro extrakci a klasifikaci, Sonnet pro orchestrátor a složitá rozhodnutí.')

ON CONFLICT (klic) DO UPDATE SET
  nazev = EXCLUDED.nazev,
  env_vars = EXCLUDED.env_vars,
  operace = EXCLUDED.operace,
  poznamka = EXCLUDED.poznamka,
  updated_at = now();

-- ============================================================
-- SEED: ucetni_pravidla — všechna účetní pravidla
-- ============================================================
INSERT INTO ucetni_pravidla
  (typ, ico, dodavatel_pattern, typ_dokladu, typ_platby, md_ucet, dal_ucet, md_dph, dal_dph, sazba_dph,
   parovat_keyword, auto_schvalit, auto_parovat, limit_auto_kc, confidence, zdroj, poznamka)
VALUES

-- === PŘEDKONTACE: GOOGLE ===
('predkontace', NULL, 'Google%', 'faktura', 'karta', '518500', '321001', NULL, NULL, 0,
 'GOOGLE', true, true, 50000, 90, 'manual',
 'Reverse charge §108/3 ZDPH. Google Ads, Workspace, Cloud. Různá IČO Google entit.'),

('predkontace', NULL, 'Google%', 'platba_karta', 'karta', '518500', '221001', NULL, NULL, 0,
 'GOOGLE', true, true, 50000, 90, 'manual',
 'Karetní platba Google — DUZP = datum platby. Reverse charge.'),

-- === PŘEDKONTACE: META / FACEBOOK ===
('predkontace', NULL, 'Meta%', 'faktura', 'karta', '518500', '321001', NULL, NULL, 0,
 'FACEBK', true, true, 50000, 90, 'manual',
 'Reverse charge. Meta Platforms Ireland. 1:1 párování s kartovou transakcí.'),

('predkontace', NULL, 'Facebook%', 'faktura', 'karta', '518500', '321001', NULL, NULL, 0,
 'FACEBK', true, true, 50000, 90, 'manual',
 'Starší název Meta. Stejná pravidla.'),

-- === PŘEDKONTACE: SEZNAM.CZ ===
('predkontace', '26168685', NULL, 'faktura', 'karta', '518100', '321001', '343', '321001', 21,
 'SEZNAM', true, true, 20000, 95, 'manual',
 'Sklik / reklama. DUZP = datum platby kartou (§21/5 ZDPH).'),

-- === PŘEDKONTACE: SAB FINANCE (FX SMĚNA) ===
('predkontace', NULL, 'SAB Finance%', 'faktura', 'prevod', '221001', '261001', NULL, NULL, 0,
 NULL, false, false, 0, 95, 'manual',
 'FX směna CZK strana. MD 221 CZK / DAL 261 Peníze na cestě. Zpracovává fx-smenarna endpoint.'),

-- === PŘEDKONTACE: TWILIO ===
('predkontace', NULL, 'Twilio%', 'faktura', 'karta', '518500', '321001', NULL, NULL, 0,
 'TWILIO', true, true, 10000, 90, 'manual',
 'Prepaid kredit. Reverse charge. Párovat nabití kreditu, ne čerpání.'),

-- === PŘEDKONTACE: DEFAULT — SLUŽBY ===
('predkontace', NULL, NULL, 'faktura', 'prevod', '518500', '321001', '343', '321001', 21,
 NULL, false, false, 50000, 50, 'manual',
 'Výchozí předkontace pro faktury za služby — převodem. Agent ověří dle kategorie.'),

('predkontace', NULL, NULL, 'platba_prevod', 'prevod', '321001', '221001', NULL, NULL, 0,
 NULL, false, false, 50000, 50, 'manual',
 'Úhrada závazku bankovním převodem.'),

('predkontace', NULL, NULL, 'platba_karta', 'karta', '518500', '221001', NULL, NULL, 0,
 NULL, false, false, 10000, 50, 'manual',
 'Karetní platba — výchozí. DUZP = datum platby kartou.'),

-- === DPH PRAVIDLA ===
('dph', NULL, 'Google%', 'faktura', NULL, NULL, NULL, NULL, NULL, 0,
 NULL, false, false, 0, 95, 'manual',
 'Reverse charge §108 odst. 3 ZDPH — DPH odvede odběratel. Základ do ř. 12/13 DAP.'),

('dph', NULL, 'Meta%', 'faktura', NULL, NULL, NULL, NULL, NULL, 0,
 NULL, false, false, 0, 95, 'manual',
 'Reverse charge — stejná pravidla jako Google.'),

-- === FX KURZ PRAVIDLA ===
('fx_kurz', NULL, NULL, NULL, NULL, '563', '221001', NULL, NULL, NULL,
 NULL, false, false, 0, 95, 'manual',
 'Kurzová ztráta při úhradě EUR/USD závazku. Zdroj kurzu: CNB denní ke dni platby.'),

('fx_kurz', NULL, NULL, NULL, NULL, '221001', '663', NULL, NULL, NULL,
 NULL, false, false, 0, 95, 'manual',
 'Kurzový zisk při úhradě EUR/USD závazku. Zdroj kurzu: CNB denní ke dni platby.'),

('fx_kurz', NULL, 'SAB Finance%', NULL, NULL, '261001', '221001', NULL, NULL, NULL,
 NULL, false, false, 0, 95, 'manual',
 'EUR výdej z FX směny — peníze na cestě 261. CNB kurz ke dni pohybu.'),

-- === SCHVÁLENÍ PRAVIDLA ===
('schvaleni', NULL, NULL, 'faktura', NULL, NULL, NULL, NULL, NULL, NULL,
 NULL, false, false, 50000, 100, 'manual',
 'Globální limit auto-schválení: max 50 000 Kč. Nad limit vždy eskalace na člověka (ústava P1).'),

('schvaleni', NULL, 'Google%', 'faktura', NULL, NULL, NULL, NULL, NULL, NULL,
 NULL, true, true, 50000, 95, 'manual',
 'Google faktury auto-schválení do 50 000 Kč.'),

('schvaleni', NULL, 'Meta%', 'faktura', NULL, NULL, NULL, NULL, NULL, NULL,
 NULL, true, true, 50000, 95, 'manual',
 'Meta faktury auto-schválení do 50 000 Kč.')

ON CONFLICT DO NOTHING;

-- ============================================================
-- SEED: mng_kategorie — manažerské kategorie
-- ============================================================
INSERT INTO mng_kategorie (nazev, popis, ucetni_ucet, stredisko, dodavatel_pattern, typ, poznamka)
VALUES
  ('Performance marketing', 'Google Ads, Meta Ads, Sklik — platba za výkon', '518500', NULL, 'Google%', 'naklady', NULL),
  ('Performance marketing', 'Facebook / Meta Ads', '518500', NULL, 'Meta%', 'naklady', NULL),
  ('Performance marketing', 'Seznam Sklik', '518100', NULL, 'Seznam%', 'naklady', NULL),
  ('IT infrastruktura', 'Cloud, hosting, SaaS nástroje', '518500', 'IT-PRD', NULL, 'naklady', NULL),
  ('Komunikace a SMS', 'Twilio, SMS brány', '518500', NULL, 'Twilio%', 'naklady', NULL),
  ('FX směna', 'Náklady na kurzové rozdíly a konverze', '563', NULL, NULL, 'naklady', NULL),
  ('Mzdy a DPP', 'Osobní náklady — zaměstnanci a externisté', '521100', NULL, NULL, 'naklady', NULL),
  ('Nájem a leasing', 'Kancelářský prostor, leasing zařízení', '548100', 'REZIJE', NULL, 'naklady', NULL),
  ('Bankovní poplatky', 'Poplatky za vedení účtu, platební brány', '568000', NULL, NULL, 'naklady', NULL)

ON CONFLICT DO NOTHING;
