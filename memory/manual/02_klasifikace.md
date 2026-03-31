# Klasifikace faktur

**Endpoint:** `POST /api/klasifikovat/:id`
**Kdy:** Automaticky při načtení UI pro všechny faktury se `stav=nova` a `kategorie_id=null` (max 10 najednou).

## Rozhodovací řetězec (v pořadí priority)

| Krok | Zdroj | Confidence | Akce |
|---|---|---|---|
| 1 | `ucetni_pravidla` — ICO přesná shoda | 90–100 | Použij, bez AI |
| 2 | `ucetni_pravidla` — pattern dodavatele (ILIKE) | 70–95 | Použij, bez AI |
| 3 | `ucetni_vzory` — naučeno z historie | 70–84 | Použij, bez AI |
| 4 | Historie faktur — stejné IČO | 75 | Použij, bez AI |
| 5 | Historie faktur — stejný název dodavatele | 65 | Použij, bez AI |
| 6 | Claude Haiku AI | 55 | Použij, označit k revizi |
| — | Žádný výsledek | 0 | kategorie_id = null |

Každé rozhodnutí se loguje do `agent_log` (typ=rozhodnuti nebo eskalace).

## Kategorie (tabulka `kategorie`)
| ID | L1 / L2 | MD účet | Středisko |
|---|---|---|---|
| 1 | Personální / CS | 521100 | CS |
| 2 | Personální / MKT | 521200 | MKT |
| 3 | Personální / CEO | 521300 | CEO |
| 4 | Personální / Provoz | 521400 | PROVOZ |
| 5 | Marketing / Výkon | 518100/518500 | MKT |
| 6 | Marketing / Produkce | 518200 | MKT |
| 7 | IT / CS | 518500 | IT-CS |
| 8 | IT / MKT | 518500 | IT-MKT |
| 9 | IT / Produkt | 518500 | IT-PRD |
| 10 | Provozní / Režie | 548100 | REZIJE |
| 11 | Provozní / Mimořádné | 549100 | MIMORAD |
| 12 | FX / Směna | 563/221001 | — |

---
*Verze 1 | Aktualizováno: 2026-03-30 | Autor: agent*
