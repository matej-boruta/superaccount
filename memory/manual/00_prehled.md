# SuperAccount — Procesní manuál agenta
*Verze: automaticky spravovaná | Tabulka: agent_manual | Aktualizuje: agent i člověk*

## Co systém dělá
Plně automatizované zpracování účetních dokladů pro holding. Agent přijímá doklady z více zdrojů, klasifikuje je, páruje s bankovními transakcemi, předkontuje a odesílá do účetního systému ABRA FlexiBee.

## Architektura
```
Gmail / Google Drive / Fio API
        ↓
   Import + parsování (Claude Haiku)
        ↓
   Klasifikace (ucetni_pravidla → ucetni_vzory → AI)
        ↓
   Párování s transakcemi (auto / manuální)
        ↓
   Schválení (auto / manuální v UI)
        ↓
   Předkontace + zápis do ABRA FlexiBee
        ↓
   Platební příkaz (ABRA + Fio API)
```

## Datové toky
- **Faktury**: Gmail → Supabase (faktury) → ABRA (faktura-prijata)
- **Transakce**: Fio API → Supabase (transakce) → párování
- **Účetní deník**: ABRA FlexiBee (zákonný záznam)
- **Agent log**: Supabase (agent_log) — audit trail rozhodnutí

## Klíčové tabulky
| Tabulka | Účel |
|---|---|
| `faktury` | Přijaté faktury — operativní data |
| `transakce` | Bankovní pohyby z Fio |
| `ucetni_pravidla` | Pravidla předkontace, párování, schválení |
| `ucetni_vzory` | Vzory naučené z historie |
| `agent_log` | Audit trail každého rozhodnutí |
| `agent_api` | Registry přístupů k externím systémům |
| `agent_ustava` | Principy fungování agenta |
| `agent_manual` | Tento manuál |

---
*Verze 1 | Aktualizováno: 2026-03-30 | Autor: agent*
