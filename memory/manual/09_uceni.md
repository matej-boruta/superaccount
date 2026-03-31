# Učení a zlepšování agenta

## Tři zdroje učení (dle ústavy P6)

### 1. Manuální korekce (nejvyšší priorita)
**Kdy:** Uživatel změní kategorii v UI před schválením faktury.
**Jak:** `schvalit-a-zaplatit` detekuje rozdíl → `savePravidlo()` → `ucetni_pravidla`
**Confidence:** 95 (manuální pravidlo)
**Efekt:** Okamžitý — příští faktura stejného dodavatele se klasifikuje správně bez AI.

Přímá korekce přes API: `POST /api/agent/learn`
```json
{
  "faktura_id": 123,
  "kategorie_id": 7,
  "md_ucet": "518500",
  "dal_ucet": "321001"
}
```

### 2. Automatické učení z historie
**Endpoint:** `POST /api/booking-agent/learn`
**Kdy:** Manuálně nebo jako nightly cron.
**Jak:** Projde všechny zaplacené/schválené faktury → extrahuje vzory per dodavatel → uloží do `ucetni_vzory` + `ucetni_pravidla`
**Confidence:** 50 + (počet_faktur × 5), max 84 %
**Pravidlo:** Automatické učení stropem 84 % — 85 %+ vyžaduje manuální potvrzení.

### 3. Cross-company transfer
Zatím neimplementováno. Stejné IČO dodavatele u jiné firmy holdingu → přenos vzoru s confidence=70.

## Rozhodovací priorita při klasifikaci
```
ucetni_pravidla (manual, conf 90–100)
  ↓ nenalezeno
ucetni_vzory (history, conf 50–84)
  ↓ nenalezeno
Historie faktur — ICO (conf 75)
  ↓ nenalezeno
Historie faktur — název (conf 65)
  ↓ nenalezeno
Claude Haiku AI (conf 55, označit k revizi)
```

## Invariant: 3 stejné korekce = pravidlo nelze přepsat automaticky
Pokud člověk 3x opraví stejného dodavatele na stejnou kategorii — pravidlo dostane příznak `zdroj=invariant` a automatické učení ho nemůže přepsat.

---
*Verze 1 | Aktualizováno: 2026-03-30 | Autor: agent*
