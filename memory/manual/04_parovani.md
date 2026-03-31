# Párování faktur s transakcemi

**Endpoint:** `POST /api/sparovat` (manuální trigger), `POST /api/auto-parovani`

## Logika párování
Faktura se páruje s transakcí pokud:
1. Variabilní symbol faktury = VS transakce **nebo**
2. Keyword z `ucetni_pravidla.parovat_keyword` ILIKE v `transakce.zprava` **nebo**
3. Částka odpovídá (tolerance ±1 %)

## Typy párování
| Typ | Příklad | Logika |
|---|---|---|
| 1:1 | Meta faktura ↔ jedna karetní platba | VS nebo keyword + částka |
| M:N | Google Ads ↔ více plateb za období | Součet plateb ≈ faktura (±5 %) |
| FX | SAB Finance | Zpracovává `fx-smenarna` endpoint — speciální logika |

## Stavy transakce
- `nepárovano` → čekání na párování
- `sparovano` → spárováno s fakturou
- `ignorovano` → vyloučeno z párování (bankovní poplatky, interní převody)

## Stavy faktury po párování
- `nova` → `sparovana` (přechod po úspěšném spárování)

## Kurzové rozdíly (EUR/USD faktury)
Při párování faktury v cizí měně s CZK platbou:
- Kurzová ztráta: **MD 563 / DAL 221001**
- Kurzový zisk: **MD 221001 / DAL 663**
- Kurz: CNB denní ke dni platby

---
*Verze 1 | Aktualizováno: 2026-03-30 | Autor: agent*
