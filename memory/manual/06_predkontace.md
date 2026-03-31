# Předkontace — účetní zápisy MD/DAL

## Základní principy (invarianty dle české účetní legislativy)

### Přijaté faktury (závazky)
```
MD 5xx (nákladový účet) / DAL 321001 (závazky z obch. vztahů)
```
Nákladový účet dle kategorie (viz Klasifikace → Kategorie).

### Úhrada faktury převodem
```
MD 321001 / DAL 221001 (bankovní účet CZK)
```

### Úhrada faktury kartou
```
MD 5xx / DAL 221001
DUZP = datum platby kartou (§21/5 ZDPH)
```

### DPH — tuzemský plátce
```
MD 343 (DPH na vstupu) / DAL 321001
Sazba 21 % (základní), 12 % (snížená), 0 % (osvobozeno)
```

### Reverse charge — zahraniční SaaS (Google, Meta, Twilio)
```
Faktura: MD 518500 / DAL 321001 (bez DPH zápisu)
DPH odvede odběratel — základ do ř. 12/13 DAP DPH
Nevstupuje do 343 jako vstupní DPH
```

### FX konverze (SAB Finance)
```
CZK výdej:  MD 261001 (peníze na cestě) / DAL 221001 (CZK účet)
EUR příjem: MD 221002 (EUR účet) / DAL 261001
Kurzový rozdíl se zaúčtuje při vyrovnání 261
```

### Kurzové rozdíly při platbě EUR/USD faktur
```
Kurzová ztráta: MD 563 / DAL 221001
Kurzový zisk:   MD 221001 / DAL 663
Kurz: CNB denní ke dni platby (zdroj: cnb_denni)
```

## Nákladové účty dle oblasti
| Účet | Oblast |
|---|---|
| 518100 | Marketing — výkon (Sklik, přímá reklama) |
| 518200 | Marketing — produkce (grafika, videa) |
| 518500 | IT / SaaS / cloud (Google Ads, Meta, Twilio) |
| 521100–521400 | Osobní náklady dle střediska |
| 548100 | Provozní režie (nájem, leasing) |
| 549100 | Mimořádné náklady |
| 563 | Kurzové ztráty |
| 568000 | Bankovní poplatky |

## Střediska
| Kód | Oblast |
|---|---|
| CS | Customer Success |
| MKT | Marketing |
| CEO | Vedení |
| PROVOZ | Provoz |
| IT-CS | IT pro CS |
| IT-MKT | IT pro Marketing |
| IT-PRD | IT Produkt |
| REZIJE | Správní režie |
| MIMORAD | Mimořádné |

---
*Verze 1 | Aktualizováno: 2026-03-30 | Autor: agent*
