# API přístupy a integrace

Kompletní registry v tabulce `agent_api`. Agent ho čte před každou operací.

## ABRA FlexiBee
- **Typ:** REST API (basic auth)
- **Env:** `ABRA_URL`, `ABRA_USER`, `ABRA_PASS`
- **Operace:** faktura-prijata, prikaz-k-uhrade, adresar, banka, mena
- **Health check:** `/status.json`
- **Degradace:** retry po 10 min při nedostupnosti

## Supabase
- **Typ:** PostgreSQL / REST API
- **Env:** `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- **REST API:** DML operace (SELECT, INSERT, UPDATE, DELETE)
- **DDL:** přes N8N PostgreSQL proxy (Supabase REST nepodporuje DDL)
- **Degradace:** abort celé operace při chybě — žádná částečná data

## Fio Banka
- **Typ:** REST API (token)
- **Env:** `FIO_TOKEN_CZK1`, `FIO_TOKEN_CZK2`, `FIO_TOKEN_EUR`, `FIO_TOKEN_USD`
- **Rate limit:** 1 req / 30 sekund per token
- **Operace:** last_transactions, by_id, by_date
- **Technický dluh:** token natvrdo v `fio-import/route.ts` — přesunout do env vars

## Google APIs
- **Typ:** OAuth2
- **Tokeny:** tabulka `google_tokens` (refresh token), automatický refresh
- **Env:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- **Operace:** Gmail (messages), Drive (files), Ads (invoices)
- **Scopes:** gmail.readonly, drive.file, adwords

## Anthropic Claude
- **Typ:** REST API (bearer)
- **Env:** `ANTHROPIC_API_KEY`
- **Modely:**
  - Extrakce PDF: `claude-haiku-4-5-20251001`
  - Klasifikace: `claude-haiku-4-5-20251001`
  - Orchestrátor: `claude-sonnet-4-6`
- **Beta header pro PDF:** `pdfs-2024-09-25`

## N8N Automation
- **URL:** `http://localhost:5678`
- **Env:** `N8N_API_KEY`
- **Role:** DDL proxy pro Supabase PostgreSQL (CREATE TABLE, ALTER TABLE)
- **Workflow pattern:** scheduleTrigger (každou minutu) → deaktivace po spuštění

---
*Verze 1 | Aktualizováno: 2026-03-30 | Autor: agent*
