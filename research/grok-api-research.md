# Ricerca Grok (xAI) — Abbonamento, API e Pricing

> **Data ricerca**: Febbraio 2026 (ultimo aggiornamento)  
> **Fonte dati**: docs.x.ai, grok.com, console.x.ai, Wikipedia, blog ufficiali xAI, TechCrunch  
> **Nota**: I prezzi e le informazioni riportate sono stati verificati direttamente dai siti ufficiali xAI dove possibile. Alcune informazioni sui piani consumer provengono da fonti secondarie attendibili (Wikipedia, TechCrunch).  
> **Stato**: ✅ Report completo — risponde a tutte e 3 le domande principali

---

## Indice

1. [Abbonamento Grok — Piani Consumer (SuperGrok)](#1-abbonamento-grok--piani-consumer-supergrok)
2. [Accesso API xAI — Pricing e Modelli](#2-accesso-api-xai--pricing-e-modelli)
3. [Come Accedere all'API](#3-come-accedere-allapi)
4. [Tabella Riepilogativa Pricing API](#4-tabella-riepilogativa-pricing-api)
5. [Fonti e Link Utili](#5-fonti-e-link-utili)

---

## 1. Abbonamento Grok — Piani Consumer (SuperGrok)

### 1.1 Panoramica dei Piani

Grok è accessibile tramite diversi livelli di abbonamento. **Non esiste un piano chiamato "Grok Max"**; il nome corretto del servizio premium standalone di xAI è **"SuperGrok"**, che è separato dagli abbonamenti X (Twitter).

| Piano | Prezzo Mensile | Dettagli |
|-------|---------------|----------|
| **Gratuito (grok.com)** | $0 | Accesso limitato a Grok. Restrizioni: ~2 prompt ogni 2 ore. Accesso al modello base. |
| **X Premium** | ~$8/mese | Accesso a Grok tramite la piattaforma X con limiti d'uso moderati. |
| **X Premium+** | **$40/mese** | Accesso completo a Grok tramite X. Prezzo aumentato da $22 a $40/mese a febbraio 2025, in concomitanza con il lancio di Grok 3. |
| **SuperGrok** | **~$30/mese** | Abbonamento standalone su grok.com. Accesso a Grok 3 e modelli successivi con limiti d'uso elevati. |
| **SuperGrok Heavy** | **$300/mese** | Tier premium lanciato a luglio 2025 insieme a Grok 4. Include accesso al modello **Grok 4 Heavy** (il più potente), tool use nativo, ricerca in tempo reale. |

### 1.2 Dettagli SuperGrok

- **SuperGrok** è un abbonamento standalone (non richiede X Premium), accessibile su **grok.com**
- Lanciato inizialmente con Grok 3 (febbraio 2025)
- Include: accesso prioritario ai modelli più recenti, limiti d'uso più elevati, DeepSearch, DeeperSearch, generazione immagini
- Il sito grok.com mostra configurazioni per:
  - `enable_heavy_subscription: true` — conferma l'esistenza del tier Heavy
  - `supergrok_paywall_annual_pricing_monthly_equivalent_enabled` — suggerisce opzione annuale disponibile o in test
  - `supergrok_paywall_hide_free_plan_card_enabled` — gestione visibilità piano free

### 1.3 SuperGrok Heavy ($300/mese)

- Lanciato il **9 luglio 2025** insieme a Grok 4 ([fonte: TechCrunch](https://techcrunch.com/2025/07/10/elon-musks-xai-launches-grok-4-alongside-a-300-monthly-subscription/))
- Include accesso a **Grok 4 Heavy** — il modello più potente di xAI
- Tool use nativo e ricerca in tempo reale integrata
- Pensato per utenti power/professionisti che necessitano del modello più avanzato

### 1.4 L'abbonamento include crediti API?

**No.** L'abbonamento SuperGrok (incluso il tier Heavy) è per l'uso **consumer** tramite l'interfaccia web/app di grok.com. **Non include crediti API né accesso API**. L'API è un servizio completamente separato con pricing a consumo (pay-per-token), gestito tramite **console.x.ai**.

---

## 2. Accesso API xAI — Pricing e Modelli

### 2.1 L'API è un servizio separato

✅ **Sì, xAI offre accesso API ai modelli Grok**, ed è un servizio **completamente separato** dagli abbonamenti consumer (X Premium / SuperGrok).

- L'API è a **consumo (pay-per-token)** — paghi per i token utilizzati
- Gestita tramite **console.x.ai** dove si creano le API key e si gestisce il billing
- Richiede registrazione separata rispetto all'account X/Twitter

### 2.2 Modelli Disponibili via API (verificati da docs.x.ai)

#### Modelli di Linguaggio (Text)

| Modello | Input $/M token | Output $/M token | Cached $/M | Context Window | Reasoning | Note |
|---------|-----------------|-------------------|------------|----------------|-----------|------|
| **grok-4** (grok-4-0709) | $3.00 | $15.00 | $0.75 | 256K | ✅ Sì | Flagship reasoning model. Alias: `grok-4-latest` |
| **grok-4-fast** (reasoning) | $0.20 | $0.50 | $0.05 | **2M** | ✅ Sì | Performance simile a Grok 4, 40% meno thinking tokens. Long context: $0.40/$1.00 |
| **grok-4-fast** (non-reasoning) | $0.20 | $0.50 | $0.05 | **2M** | ❌ No | Stessi prezzi, modo non-reasoning |
| **grok-4-1-fast** (reasoning) | $0.20 | $0.50 | $0.05 | **2M** | ✅ Sì | Ultimo aggiornamento (nov 2025). Long context: $0.40/$1.00 |
| **grok-4-1-fast** (non-reasoning) | $0.20 | $0.50 | $0.05 | **2M** | ❌ No | Versione non-reasoning di 4.1 Fast |
| **grok-3** | $3.00 | $15.00 | $0.75 | 131K | ❌ No | Alias: `grok-3-latest`, `grok-3-beta`, `grok-3-fast` |
| **grok-3-mini** | $0.30 | $0.50 | $0.07 | 131K | ✅ Sì | Alias: `grok-3-mini-latest`, `grok-3-mini-fast` |
| **grok-2** (grok-2-1212) | $2.00 | $10.00 | N/A | 131K | ❌ No | Alias: `grok-2-latest` |
| **grok-2-vision** (grok-2-vision-1212) | $2.00 | $10.00 | N/A | 32K | ❌ No | Input: testo + immagini |
| **grok-code-fast-1** | $0.20 | $1.50 | $0.02 | 256K | ✅ Sì | Ottimizzato per coding agentico |

#### Modelli in arrivo

| Modello | Status |
|---------|--------|
| **Grok 4.20** | Early Access — coming soon. Richiesta accesso anticipato su docs.x.ai |
| **Grok 4.20 Multi-Agent** | Early Access — coming soon |

#### Modelli di Generazione Immagini

| Modello | Tipo |
|---------|------|
| **grok-imagine-image** | Generazione immagini da testo |
| **grok-imagine-image-pro** | Generazione immagini (qualità superiore) |
| **grok-2-image** (grok-2-image-1212) | Generazione immagini (legacy) |

#### Modelli Video e Audio

| Modello | Tipo |
|---------|------|
| **grok-imagine-video** | Generazione video |
| **Voice Agent API** | Conversazione vocale in tempo reale |

### 2.3 Pricing Dettagliato — Long Context

Per i modelli **grok-4-fast** e **grok-4-1-fast**, il pricing cambia quando si supera la soglia di **128.000 token** nel prompt:

| Modello | Input (standard) | Input (long ctx >128K) | Output (standard) | Output (long ctx) |
|---------|-------------------|------------------------|--------------------|--------------------|
| grok-4-fast / grok-4-1-fast | $0.20/M | $0.40/M | $0.50/M | $1.00/M |
| grok-4 (0709) | $3.00/M | $6.00/M | $15.00/M | $30.00/M |

### 2.4 Pricing Tools (Server-side)

| Tool | Costo per 1.000 chiamate | API Name |
|------|--------------------------|----------|
| **Web Search** | $5.00 | `web_search` |
| **X Search** | $5.00 | `x_search` |
| **Code Execution** | $5.00 | `code_execution` / `code_interpreter` |
| **File Attachments** | $10.00 | `attachment_search` |
| **Collections Search (RAG)** | $2.50 | `collections_search` / `file_search` |
| **Image Understanding** | Token-based | `view_image` |
| **X Video Understanding** | Token-based | `view_x_video` |
| **Remote MCP Tools** | Token-based | Definito dal server MCP |

### 2.5 Batch API Pricing

La **Batch API** permette di elaborare grandi volumi di richieste in modo asincrono al **50% del prezzo standard**:

| | Real-time API | Batch API |
|---|---|---|
| **Pricing** | Standard | **50% di sconto** su tutti i token |
| **Tempo di risposta** | Immediato (secondi) | Tipicamente entro 24 ore |
| **Rate limits** | Si applicano | Non contano verso i rate limits |
| **Modelli** | Tutti | Solo modelli text/language (no immagini/video) |

### 2.6 Voice Agent API Pricing

| Dettaglio | Valore |
|-----------|--------|
| **Prezzo** | $0.05/minuto ($3.00/ora) |
| **Rate Limit** | 100 sessioni concorrenti per team |
| **Capacità** | Function calling, web search, X search, collections, custom functions |

> **Nota:** I costi di tool invocation si sommano al costo per minuto della sessione vocale.

### 2.7 Rate Limits

- I rate limits variano per modello e per tier dell'account
- Ogni modello ha limiti di **requests per minute (RPM)** e **tokens per minute (TPM)**
- Per richiedere rate limits più elevati: contattare xAI via email
- I rate limits del proprio team sono consultabili su **console.x.ai**
- I dati estratti indicano rate limits base come:
  - grok-4 (0709): ~600 RPM base
  - grok-4-1-fast: ~480 RPM base
  - grok-3: ~600 RPM base
  - grok-3-mini: ~480 RPM base

### 2.8 Altre Note sul Pricing

- **Reasoning tokens**: addebitati allo stesso prezzo dei completion tokens
- **Cached prompt tokens**: sconto automatico (caching prefix matching), nessuna configurazione richiesta
- **Image prompt tokens**: 256–1.792 token per immagine, dipende dalle dimensioni
- **Usage Guidelines Violation Fee**: $0.05 per richiesta che viola le linee guida d'uso

---

## 3. Come Accedere all'API

### 3.1 Endpoint API

| Dettaglio | Valore |
|-----------|--------|
| **Base URL** | `https://api.x.ai/v1` |
| **Responses API** | `https://api.x.ai/v1/responses` |
| **Formato** | ✅ **Compatibile OpenAI** (drop-in replacement) |
| **Autenticazione** | Bearer token (API Key) |
| **Console** | `https://console.x.ai` |
| **Documentazione** | `https://docs.x.ai` |

### 3.2 Registrazione

1. **Vai su** [console.x.ai](https://console.x.ai)
2. **Crea un account** — registrazione separata rispetto a X/Twitter
3. **Genera una API Key** nella console
4. **Imposta il billing** — pay-per-token (nessun abbonamento richiesto per l'API)
5. **Inizia a fare richieste** all'endpoint `https://api.x.ai/v1`

### 3.3 Compatibilità OpenAI

L'API xAI è **completamente compatibile con il formato OpenAI**. Si può utilizzare:

#### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    api_key="<YOUR_XAI_API_KEY>",
    base_url="https://api.x.ai/v1",
)

response = client.responses.create(
    model="grok-4-1-fast-reasoning",
    input=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "What is the meaning of life?"}
    ]
)
```

#### Node.js (OpenAI SDK)
```javascript
import OpenAI from "openai";

const client = new OpenAI({
    apiKey: "<api key>",
    baseURL: "https://api.x.ai/v1",
});

const response = await client.responses.create({
    model: "grok-4-1-fast-reasoning",
    input: [{ role: "user", content: "Hello!" }]
});
```

#### cURL
```bash
curl https://api.x.ai/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -d '{
    "model": "grok-4-1-fast-reasoning",
    "input": [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "What is the meaning of life?"}
    ]
  }'
```

### 3.4 SDK Nativo xAI

Oltre alla compatibilità OpenAI, xAI offre un **SDK nativo** basato su gRPC:

```python
import xai_sdk
from xai_sdk.chat import user, system

client = xai_sdk.Client(api_key="<YOUR_XAI_API_KEY>")
```

L'SDK nativo supporta funzionalità aggiuntive come Collections, Voice API, gestione API key, e utilizza gRPC per performance ottimali.

### 3.5 Vercel AI SDK

Disponibile anche integrazione con il **Vercel AI SDK**:

```javascript
import { xai } from '@ai-sdk/xai';
```

---

## 4. Tabella Riepilogativa Pricing API

### Modelli Principali — Prezzo per Milione di Token

| Modello | Input | Output | Cached Input | Context | Best For |
|---------|-------|--------|--------------|---------|----------|
| **grok-4-1-fast** (reasoning) | **$0.20** | **$0.50** | $0.05 | 2M | ⭐ Miglior rapporto qualità/prezzo per reasoning |
| **grok-4-1-fast** (non-reasoning) | **$0.20** | **$0.50** | $0.05 | 2M | Chat veloce, alto volume |
| **grok-4** | $3.00 | $15.00 | $0.75 | 256K | Massima qualità reasoning |
| **grok-code-fast-1** | $0.20 | $1.50 | $0.02 | 256K | Coding agentico |
| **grok-3** | $3.00 | $15.00 | $0.75 | 131K | Legacy, non-reasoning |
| **grok-3-mini** | $0.30 | $0.50 | $0.07 | 131K | Budget reasoning |
| **grok-2** | $2.00 | $10.00 | — | 131K | Legacy |

### Confronto con Competitor (indicativo)

| Modello | Input $/M | Output $/M |
|---------|-----------|------------|
| **grok-4-1-fast** | $0.20 | $0.50 |
| GPT-4o-mini (OpenAI) | $0.15 | $0.60 |
| Claude 3.5 Haiku | $0.80 | $4.00 |
| **grok-4** | $3.00 | $15.00 |
| GPT-4o (OpenAI) | $2.50 | $10.00 |
| Claude 3.5 Sonnet | $3.00 | $15.00 |

> ⚠️ **Nota**: I prezzi dei competitor sono indicativi e potrebbero essere cambiati. Verificare sui rispettivi siti.

---

## 5. Fonti e Link Utili

### Risorse Ufficiali xAI

| Risorsa | URL |
|---------|-----|
| **Sito xAI** | [https://x.ai](https://x.ai) |
| **Grok (Consumer)** | [https://grok.com](https://grok.com) |
| **Documentazione API** | [https://docs.x.ai](https://docs.x.ai) |
| **Console API (Billing & Keys)** | [https://console.x.ai](https://console.x.ai) |
| **Modelli e Pricing** | [https://docs.x.ai/docs/models](https://docs.x.ai/docs/models) |
| **Rate Limits** | [https://docs.x.ai/docs/rate-limits](https://docs.x.ai/docs/rate-limits) |
| **Getting Started** | [https://docs.x.ai/docs/overview](https://docs.x.ai/docs/overview) |
| **Blog xAI** | [https://x.ai/blog](https://x.ai/blog) |
| **Annuncio Grok 4** | [https://x.ai/blog/grok-4](https://x.ai/blog/grok-4) |
| **Annuncio Grok 4.1** | [https://x.ai/news/grok-4-1](https://x.ai/news/grok-4-1) |

### Fonti Giornalistiche

| Articolo | Testata |
|----------|---------|
| "Elon Musk's xAI launches Grok 4 alongside a $300 monthly subscription" | TechCrunch, 10 luglio 2025 |
| "Grok 4 is free for a limited time, as xAI competes with GPT-5" | Mashable, 11 agosto 2025 |
| "What to know about Grok 4 Fast for enterprise use cases" | VentureBeat, 23 settembre 2025 |
| "xAI announces Grok 4.1" | The Verge, 18 novembre 2025 |

### Wikipedia

| Voce | URL |
|------|-----|
| Grok (chatbot) | [https://en.wikipedia.org/wiki/Grok_(chatbot)](https://en.wikipedia.org/wiki/Grok_(chatbot)) |

---

## Risposte Rapide alle Domande

### ❓ Esiste un piano "Grok Max"?
**No.** Il nome corretto è **"SuperGrok"** (base) e **"SuperGrok Heavy"** ($300/mese). Non esiste un piano denominato "Grok Max".

### ❓ L'abbonamento SuperGrok include crediti API?
**No.** L'abbonamento SuperGrok è solo per l'uso consumer (interfaccia web/app). L'API è un servizio separato con pricing a consumo tramite console.x.ai.

### ❓ Quanto costa usare l'API?
Dipende dal modello. Il migliore rapporto qualità/prezzo è **grok-4-1-fast** a $0.20/M input e $0.50/M output. Il modello top **grok-4** costa $3.00/M input e $15.00/M output.

### ❓ L'API è compatibile con OpenAI?
**Sì, completamente.** Basta cambiare `base_url` a `https://api.x.ai/v1` nel client OpenAI.

### ❓ Serve un account X/Twitter per l'API?
**No.** L'API si gestisce tramite console.x.ai con registrazione separata.

---

## Disclaimer

Le informazioni contenute in questo report sono state raccolte da fonti pubbliche ufficiali (docs.x.ai, console.x.ai, grok.com) e da testate giornalistiche affidabili (TechCrunch, VentureBeat, The Verge). I prezzi e le funzionalità possono variare nel tempo. Si consiglia di verificare sempre sui siti ufficiali xAI prima di prendere decisioni di acquisto.

*Report compilato da lead-researcher per Insurtech Solutions — Febbraio 2026*
