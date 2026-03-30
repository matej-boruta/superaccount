-- ============================================================
-- AGENT TABLES — paměť a audit trail agenta SuperAccount
-- Migrace: 2026-03-31
-- ============================================================

-- ------------------------------------------------------------
-- agent_knowledge — registr nástrojů, konfigurace, znalostní báze
-- Klíč = (kategorie, klic), hodnota = JSONB
-- Kategorie: 'nastroje', 'kontext', 'pravidla', 'kurzy_cache'
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_knowledge (
  kategorie     TEXT NOT NULL,
  klic          TEXT NOT NULL,
  hodnota       JSONB NOT NULL,
  zdroj         TEXT DEFAULT 'manual',       -- 'manual', 'agent', 'cron'
  poznamka      TEXT,
  updated_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (kategorie, klic)
);

-- ------------------------------------------------------------
-- agent_log — černá skříňka: každé rozhodnutí, plán, korekce
-- Nikdy se nemaže — jen archivuje
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_log (
  id            SERIAL PRIMARY KEY,
  typ           TEXT NOT NULL,               -- 'plan', 'rozhodnuti', 'korekce', 'eskalace', 'chyba'
  vstup         JSONB,                       -- co agent dostal
  vystup        JSONB,                       -- co agent rozhodl
  confidence    INTEGER,                     -- 0-100
  pravidlo_zdroj TEXT,                       -- 'ustava', 'dodavatel_pravidla', 'ucetni_vzory', 'odvozeno'
  faktura_id    INTEGER,
  transakce_id  INTEGER,
  agent_id      TEXT DEFAULT 'superaccount', -- pro budoucí multi-agent setup
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_log_faktura_idx ON agent_log (faktura_id);
CREATE INDEX IF NOT EXISTS agent_log_typ_idx ON agent_log (typ);
CREATE INDEX IF NOT EXISTS agent_log_created_idx ON agent_log (created_at DESC);

-- ------------------------------------------------------------
-- dodavatel_pravidla — explicitní pravidla per dodavatel
-- Nejvyšší priorita v rozhodovacím cyklu (P4 ústavy)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dodavatel_pravidla (
  id                SERIAL PRIMARY KEY,
  dodavatel_pattern TEXT NOT NULL,           -- název nebo pattern (case-insensitive match)
  ico               TEXT,                    -- IČO pro přesnou shodu (priorita před pattern)
  kategorie_id      INTEGER,
  typ_platby        TEXT,                    -- 'karta', 'prevod'
  auto_schvalit     BOOLEAN DEFAULT false,
  auto_parovat      BOOLEAN DEFAULT false,
  limit_auto_kc     NUMERIC DEFAULT 50000,   -- max částka pro auto-schválení
  parovat_keyword   TEXT,                    -- keyword v bankovním výpisu
  md_ucet           TEXT,                    -- předkontace MD (override ucetni_vzory)
  dal_ucet          TEXT,                    -- předkontace DAL
  sazba_dph         NUMERIC,                -- 0, 12, 21
  poznamka          TEXT,
  confidence        INTEGER DEFAULT 95,      -- výchozí 95 pro manuální pravidla
  zdroj             TEXT DEFAULT 'manual',
  aktivni           BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dodavatel_pravidla_ico_idx ON dodavatel_pravidla (ico);
CREATE INDEX IF NOT EXISTS dodavatel_pravidla_pattern_idx ON dodavatel_pravidla (dodavatel_pattern);

-- ============================================================
-- SEED: registr nástrojů v agent_knowledge
-- ============================================================
INSERT INTO agent_knowledge (kategorie, klic, hodnota, zdroj, poznamka)
VALUES

-- ABRA FlexiBee
('nastroje', 'abra', '{
  "nazev": "ABRA FlexiBee",
  "typ": "rest_api",
  "auth": "basic_env",
  "env_url": "ABRA_URL",
  "env_user": "ABRA_USER",
  "env_pass": "ABRA_PASS",
  "operace": ["faktura-prijata", "banka", "adresar", "mena"],
  "rate_limit": null,
  "health_endpoint": "/status.json",
  "stav": "neznamy"
}', 'manual', 'Hlavní účetní systém. Credentials v env vars.'),

-- Supabase
('nastroje', 'supabase', '{
  "nazev": "Supabase",
  "typ": "rest_api",
  "auth": "service_key_env",
  "env_url": "NEXT_PUBLIC_SUPABASE_URL",
  "env_key": "SUPABASE_SERVICE_KEY",
  "operace": ["faktury", "transakce", "kategorie", "agent_knowledge", "agent_log", "dodavatel_pravidla", "ucetni_vzory", "ucetni_denik", "smlouvy", "kurzy", "google_tokens"],
  "stav": "neznamy"
}', 'manual', 'Primární databáze. Credentials v env vars.'),

-- Fio Banka
('nastroje', 'fio', '{
  "nazev": "Fio Banka API",
  "typ": "rest_api",
  "auth": "token_env",
  "ucty": [
    {"label": "CZK1", "env": "FIO_TOKEN_CZK1"},
    {"label": "CZK2", "env": "FIO_TOKEN_CZK2"},
    {"label": "EUR",  "env": "FIO_TOKEN_EUR"},
    {"label": "USD",  "env": "FIO_TOKEN_USD"}
  ],
  "rate_limit_sec": 30,
  "operace": ["last_transactions", "by_id", "by_date"],
  "stav": "neznamy",
  "poznamka_technickeho_dluhu": "Tokeny jsou aktuálně natvrdo v kódu fio-import/route.ts — přesunout do env vars"
}', 'manual', 'Bankovní API pro import transakcí. Rate limit 1 req/30s per token.'),

-- Google (Gmail + Drive + Ads)
('nastroje', 'google', '{
  "nazev": "Google APIs",
  "typ": "oauth2",
  "auth": "oauth_db",
  "token_tabulka": "google_tokens",
  "env_client_id": "GOOGLE_CLIENT_ID",
  "env_client_secret": "GOOGLE_CLIENT_SECRET",
  "operace": ["gmail.messages", "drive.files", "ads.invoices"],
  "stav": "neznamy"
}', 'manual', 'OAuth tokeny uloženy v google_tokens tabulce. Refresh automaticky.'),

-- N8N
('nastroje', 'n8n', '{
  "nazev": "N8N Automation",
  "typ": "rest_api",
  "auth": "api_key_env",
  "env_url": "N8N_URL",
  "env_key": "N8N_API_KEY",
  "operace": ["workflow.trigger", "workflow.status"],
  "stav": "neznamy"
}', 'manual', 'Orchestrátor automatizací. URL: localhost:5678 nebo produkční instance.'),

-- Claude API
('nastroje', 'claude', '{
  "nazev": "Anthropic Claude",
  "typ": "rest_api",
  "auth": "api_key_env",
  "env_key": "ANTHROPIC_API_KEY",
  "modely": {
    "extrakce": "claude-haiku-4-5-20251001",
    "rozhodovani": "claude-haiku-4-5-20251001",
    "orchestrator": "claude-sonnet-4-6"
  },
  "stav": "neznamy"
}', 'manual', 'AI modely. Haiku pro extrakci a klasifikaci, Sonnet pro orchestrátor.')

ON CONFLICT (kategorie, klic) DO UPDATE
  SET hodnota = EXCLUDED.hodnota,
      updated_at = now();

-- ============================================================
-- SEED: dodavatel_pravidla — known vendors
-- ============================================================
INSERT INTO dodavatel_pravidla
  (dodavatel_pattern, ico, kategorie_id, typ_platby, auto_schvalit, auto_parovat, limit_auto_kc, parovat_keyword, md_ucet, dal_ucet, sazba_dph, poznamka)
VALUES

-- Google Ads / Google Ireland
('Google Ireland', NULL, NULL, 'karta', true, true, 50000, 'GOOGLE*ADS',
 '518500', '321001', 0, 'Reverse charge §108/3 ZDPH. M:N párování — více transakcí na fakturu.'),

-- Google Workspace / Cloud
('Google', NULL, NULL, 'karta', true, true, 10000, 'GOOGLE',
 '518500', '321001', 0, 'Reverse charge. Různá IČO Google entit — match dle názvu.'),

-- Meta / Facebook Ads
('Meta Platforms', NULL, NULL, 'karta', true, true, 50000, 'FACEBK',
 '518500', '321001', 0, 'Reverse charge. 1:1 párování s kartovou transakcí.'),

('Facebook', NULL, NULL, 'karta', true, true, 50000, 'FACEBK',
 '518500', '321001', 0, 'Starší název Meta. Reverse charge.'),

-- SAB Finance (FX směnárna)
('SAB Finance', NULL, 13, 'prevod', false, false, 0, NULL,
 '221001', '261001', 0, 'FX směna. Zpracovává fx-smenarna endpoint. Nepárovat automaticky.'),

-- Seznam.cz
('Seznam.cz', '26168685', NULL, 'karta', true, true, 20000, 'SEZNAM',
 '518100', '321001', 21, 'Karetní platba. DUZP = datum platby kartou (§21/5 ZDPH).'),

-- Twilio (SMS/komunikace)
('Twilio', NULL, NULL, 'karta', true, true, 10000, 'TWILIO',
 '518500', '321001', 0, 'Prepaid kredit. Reverse charge. Párovat nabití kreditu, ne čerpání.')

ON CONFLICT DO NOTHING;
