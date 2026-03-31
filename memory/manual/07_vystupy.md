# Výstupy systému

## 1. ABRA FlexiBee
Zákonný účetní systém. Všechny schválené faktury se sem zapisují.

**Objekt `faktura-prijata`:**
- Kód: `FP-{id}-{rok}` (unikátní identifikátor)
- Datum vystavení, splatnosti, účtování
- Měna, částka bez DPH, sazba DPH
- Předkontace (ucetni_kod, stredisko)
- Vazba na adresář (IČO → ABRA firma ID)

**Objekt `prikaz-k-uhrade`:**
- Vazba na faktura-prijata
- Datum splatnosti
- Variabilní symbol, částka, měna

## 2. Fio API — platební příkazy
Automatické odeslání platby při schválení (pokud `FIO_TOKEN` a `FIO_ACCOUNT` nakonfigurovány).
Formát: XML DomesticTransaction.
Výsledek: `fio_payment_id` uložen na faktuře.

## 3. Google Drive — archiv PDF
Všechna PDF faktur nahrána do složky `19uD7bGxQTbDLn57L4tpBtH-9bG4lYXl8`.
Formát názvu: `YYYYMMDD_předmět_názevsouboru.pdf`
Reference: `faktury.gdrive_file_id`

## 4. Supabase — operativní databáze
Primární datové úložiště celého systému.
- `faktury` — všechny doklady vč. stavu zpracování
- `transakce` — bankovní pohyby
- `agent_log` — audit trail každého rozhodnutí

## 5. agent_log — audit trail
Každé rozhodnutí agenta → jeden záznam:
```json
{
  "typ": "rozhodnuti",
  "vstup": { "faktura_id": 123, "dodavatel": "Google" },
  "vystup": { "kategorie_id": 5, "zdroj": "ucetni_pravidla" },
  "confidence": 90,
  "pravidlo_zdroj": "ucetni_pravidla"
}
```
Typy: `plan`, `rozhodnuti`, `korekce`, `eskalace`, `chyba`

---
*Verze 1 | Aktualizováno: 2026-03-30 | Autor: agent*
