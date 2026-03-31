# Účetní pravidla

Tabulka `ucetni_pravidla` je jediný zdroj pravdy pro všechna účetní pravidla systému.
Nahrazuje: `ucetni_vzory` (zpětná kompatibilita zachována), `dodavatel_pravidla` (smazána).

## Typy pravidel (sloupec `typ`)
| Typ | Účel |
|---|---|
| `predkontace` | MD/DAL účty, DPH sazba, středisko pro daného dodavatele |
| `schvaleni` | Auto-schválení (do limitu, pro daného dodavatele) |
| `parovani` | Keyword v bankovním výpisu pro auto-párování |
| `dph` | Specifická DPH pravidla (reverse charge, osvobození) |
| `fx_kurz` | Pravidla pro kurzové přepočty |
| `smlouva` | Opakující se závazky (subscription, nájem) |
| `casove_rozliseni` | Pravidla pro 381/383 |
| `zaloha` | Zálohy a jejich zúčtování |

## Aktuální manuální pravidla (zdroj=manual, confidence≥90)

### Google (Ads, Workspace, Cloud)
- **Pattern:** `Google%` | **ICO:** různá Google entit
- **MD:** 518500 | **DAL:** 321001 | **DPH:** 0 % (reverse charge)
- **Kategorie:** 5 (Marketing/Výkon)
- **Platba:** karta | **Auto-schválení:** ano (do 50 000 Kč)
- **Párování:** keyword `GOOGLE`
- **Proč:** Zahraniční subjekt §108/3 ZDPH — DPH odvede odběratel. DUZP = datum platby kartou.

### Meta Platforms / Facebook
- **Pattern:** `Meta%`, `Facebook%`
- **MD:** 518500 | **DAL:** 321001 | **DPH:** 0 % (reverse charge)
- **Kategorie:** 5 (Marketing/Výkon)
- **Platba:** karta | **Auto-schválení:** ano (do 50 000 Kč)
- **Párování:** keyword `FACEBK`
- **Proč:** Stejný režim jako Google — irský subjekt, reverse charge.

### Seznam.cz (Sklik)
- **IČO:** 26168685 (přesná shoda)
- **MD:** 518100 | **DAL:** 321001 | **DPH:** 21 % | **MD DPH:** 343
- **Kategorie:** 5 (Marketing/Výkon)
- **Platba:** karta | **Auto-schválení:** ano (do 20 000 Kč)
- **Párování:** keyword `SEZNAM`
- **Proč:** CZ plátce DPH, karetní platba, DUZP = datum platby kartou (§21/5 ZDPH).

### SAB Finance (FX směnárna)
- **Pattern:** `SAB Finance%`
- **MD:** 221001 | **DAL:** 261001 | **DPH:** 0 %
- **Kategorie:** 12 (FX/Směna)
- **Platba:** prevod | **Auto-schválení:** ne
- **Proč:** FX konverze — peníze na cestě (261). Zpracovává endpoint `fx-smenarna`.

### Twilio
- **Pattern:** `Twilio%`
- **MD:** 518500 | **DAL:** 321001 | **DPH:** 0 % (reverse charge)
- **Kategorie:** 7 (IT/CS)
- **Platba:** karta | **Auto-schválení:** ano (do 10 000 Kč)
- **Párování:** keyword `TWILIO`
- **Proč:** US subjekt, prepaid kredit. Párovat nabití kreditu, ne čerpání.

## Výchozí pravidla (fallback, confidence=50)
- Faktura/převod: MD 518500 / DAL 321001 / DPH 21 %
- Úhrada závazku: MD 321001 / DAL 221001
- Karetní platba: MD 518500 / DAL 221001

## Učení a aktualizace pravidel
- **Manuální korekce:** Při schválení s jinou kategorií → confidence=95, uloží se okamžitě
- **Z historie:** `POST /api/booking-agent/learn` → projde zaplacené faktury → confidence=50–84
- **Strop automatického učení:** 84 % — 85 %+ vyžaduje manuální pravidlo

---
*Verze 1 | Aktualizováno: 2026-03-30 | Autor: agent*
