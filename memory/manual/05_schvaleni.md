# Schválení a platba

## Manuální schválení (UI)
Uživatel vidí faktury se `stav=nova` nebo `stav=sparovana`.
Může změnit kategorii (dropdown) před schválením.

**Endpoint:** `POST /api/schvalit-a-zaplatit/:id`
Body: `{ kategorie_id?: number }` — volitelný override kategorie

## Auto-schválení
Faktury s `ucetni_pravidla.auto_schvalit=true` a `castka_s_dph ≤ limit_auto_kc` mohou být schváleny automaticky.
Aktuálně auto-schválení: Google (≤50 000 Kč), Meta (≤50 000 Kč), Seznam (≤20 000 Kč), Twilio (≤10 000 Kč).

**Limit dle ústavy P1:** Nad 50 000 Kč vždy eskalace na člověka — bez výjimky.

## Workflow při schválení (schvalit-a-zaplatit)
1. **Načti fakturu** z Supabase
2. **Urči kategorii:** body override → ucetni_pravidla → faktura.kategorie_id → Claude AI
3. **Pokud změněna kategorie** → ulož jako pravidlo (learning, confidence=95)
4. **Předkontace:** ucetni_pravidla.md_ucet → kategorie.ucetni_kod → fallback (518500)
5. **Datum platby:** 1 pracovní den před splatností
6. **Supabase:** faktura.stav = `schvalena`, datum_platby, kategorie_id
7. **ABRA FlexiBee:** vytvoří `faktura-prijata` + `prikaz-k-uhrade`
8. **Fio API:** odešle platební příkaz (pokud nakonfigurováno)

## Předkontace při schválení
| Případ | MD | DAL | Poznámka |
|---|---|---|---|
| Faktura za služby (CZ) | 5xx | 321001 | Dle kategorie |
| Faktura zahraniční (reverse charge) | 518500 | 321001 | DPH = 0 |
| Platba převodem | 321001 | 221001 | Úhrada závazku |
| Platba kartou | 5xx | 221001 | DUZP = datum platby |
| FX konverze | 221001 | 261001 | Peníze na cestě |

## Výjimky a eskalace
- Faktura > 50 000 Kč → vždy manuální schválení
- Chybí účet dodavatele (cislo_uctu) → platba z Fio se neodesílá
- ABRA nedostupná → retry po 10 min, faktura zůstává `schvalena` (ne `zaplacena`)

---
*Verze 1 | Aktualizováno: 2026-03-30 | Autor: agent*
