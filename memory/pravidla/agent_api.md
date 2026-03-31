# Registry API přístupů

| Klíč | Název | Typ | Stav | Poznámka |
|---|---|---|---|---|
| abra | ABRA FlexiBee | rest_api | neznamy | Hlavní účetní systém. Endpoint /status.json pro health check |
| claude | Anthropic Claude | rest_api | neznamy | AI inference. Haiku pro extrakci, Sonnet pro orchestrátor. |
| fio_czk1 | Fio Banka CZK1 | rest_api | neznamy | Hlavní CZK účet. Rate limit 1 req/30s. Tech dluh: token natv |
| fio_czk2 | Fio Banka CZK2 | rest_api | neznamy | Druhý CZK účet. |
| fio_eur | Fio Banka EUR | rest_api | neznamy | EUR účet. Kurzové rozdíly přes 261/563/663. |
| fio_usd | Fio Banka USD | rest_api | neznamy | USD účet. |
| google | Google APIs | oauth2 | neznamy | OAuth tokeny v tabulce google_tokens. |
| n8n | N8N Automation | rest_api | ok | Orchestrátor automatizací a PostgreSQL proxy pro DDL operace |
| supabase | Supabase | postgres | ok | Primární databáze. |
