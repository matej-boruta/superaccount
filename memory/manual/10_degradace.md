# Chybové stavy a degradace

## Princip (ústava P10)
Agent nikdy nespadne tiše. Každá chyba se označí, zaloguje, a systém pokračuje na dalším dokladu.

## Degradační scénáře

| Systém | Chyba | Reakce agenta |
|---|---|---|
| ABRA nedostupná | HTTP 5xx nebo timeout | Faktura zůstane `schvalena`, retry po 10 min |
| Supabase chyba | HTTP 5xx | Abort celé operace, žádná částečná data |
| Claude API nedostupné | HTTP 5xx nebo timeout | Použij deterministická pravidla z `ucetni_pravidla`, bez AI |
| Fio nedostupná | HTTP 5xx | Platba se neodesílá, faktura zůstane `schvalena` (ne `zaplacena`) |
| Gmail/Drive timeout | — | Log chyby, přeskoč zprávu, pokračuj na další |
| PDF nejde parsovat | Claude vrátí null | Fallback hodnoty (dodavatel z emailu, castka=null), reparsování při příštím importu |

## Stavy faktury
```
nova → klasifikována (kategorie_id set)
nova → sparovana (spárováno s transakcí)
sparovana / nova → schvalena (schválení)
schvalena → zaplacena (platba odeslána)
nova / sparovana → zamitnuta (zamítnutí)
* → chyba (s popisem chyby)
```

## Monitoring
- `agent_api.stav` — stav každého API přístupu (ok / chyba / neznamy / degradovany)
- `agent_api.posledni_chyba` — poslední chybová zpráva
- `agent_api.posledni_check` — čas posledního health checku
- `agent_log` typ=`chyba` — každá chyba v rozhodování

---
*Verze 1 | Aktualizováno: 2026-03-30 | Autor: agent*
