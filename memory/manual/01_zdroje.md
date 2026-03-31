# Zdroje dokladů

## 1. Gmail — faktury emailem
**Endpoint:** `POST /api/google/sync-ads-faktury`
**Kdy:** Manuálně nebo cron. Prohledává od 1.1.2025.
**Filtr:** `from:(billing-noreply@google.com OR payments-noreply@google.com) subject:(invoice OR faktura)`

**Workflow:**
1. Gmail API → seznam zpráv
2. Pro každou zprávu: hledá PDF přílohu, nebo stahuje PDF z download linku v HTML
3. Nahraje PDF do Google Drive (složka `19uD7bGxQTbDLn57L4tpBtH-9bG4lYXl8`)
4. Parsuje PDF přes Claude (SYSTEM_EXTRAKCE)
5. Ukládá do `faktury` (stav=nova, email_id pro deduplikaci)

**Deduplikace:** `email_id` — každý Gmail message ID se zpracuje max jednou. Pokud `castka_s_dph = null`, reparsuje.

---

## 2. Google Ads API — faktury přímou cestou
**Endpoint:** `POST /api/google/sync-ads-api`
**Kdy:** Manuálně nebo cron. Pokrývá 2025-01 až aktuální měsíc.
**Potřebuje:** `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`

**Workflow:**
1. InvoiceService.ListInvoices per měsíc
2. Stáhne PDF, nahraje do Drive, parsuje Claude
3. Ukládá do `faktury` (deduplikace přes `cislo_faktury`)
4. Pokud existuje bez `gdrive_file_id` — doplní Drive ID

---

## 3. Google Drive — složka s fakturami
**Endpoint:** `POST /api/google/sync-drive-faktury`
**Složka:** `19uD7bGxQTbDLn57L4tpBtH-9bG4lYXl8`

Prochází všechna PDF v Drive složce, parsuje přes Claude, ukládá do `faktury`.

---

## 4. Fio Banka — bankovní transakce
**Endpoint:** `POST /api/fio-import`
**Účty:** CZK1, CZK2, EUR, USD (tokeny v env vars FIO_TOKEN_*)
**Rate limit:** 1 request / 30 sekund per token

Importuje pohyby za posledních 30 dní. Ukládá do `transakce` (stav=nepárovano).

---

## 5. Manuální import
Přes UI nebo přímý POST do Supabase. Faktura se vytvoří se `stav=nova`.

---
*Verze 1 | Aktualizováno: 2026-03-30 | Autor: agent*
