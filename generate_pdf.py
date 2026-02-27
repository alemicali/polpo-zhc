#!/usr/bin/env python3
"""
Generate a professional PDF with 3 contact email drafts for top surety companies.
Uses weasyprint for PDF generation with clean HTML/CSS styling.
"""

import markdown
from weasyprint import HTML

# ─── Email 1: Tokio Marine HCC ────────────────────────────────────────────────

email_tokio = """
<div class="email-block">
<div class="company-header">
<h1>1. TOKIO MARINE HCC</h1>
<p class="subtitle">International Surety Division — London | Delegated Authority Team</p>
<p class="meta">Rating: A++ AM Best (Superior) &nbsp;|&nbsp; Sede: Regno Unito (Gruppo Giappone) &nbsp;|&nbsp; Operatività Italia: LPS</p>
</div>

<div class="email-content">

<table class="email-meta">
<tr><td class="label">From:</td><td>[NOME COGNOME], CEO — Insurtech Solutions S.r.l.</td></tr>
<tr><td class="label">To:</td><td>International Surety Division / Delegated Authority Team — Tokio Marine HCC, London</td></tr>
<tr><td class="label">Date:</td><td>[DATA]</td></tr>
<tr><td class="label">Subject:</td><td><strong>MGA Partnership Proposal — Italian Surety Market (Ramo 15 — Bonds &amp; Guarantees)</strong></td></tr>
</table>

<div class="email-body">

<p>Dear Sir/Madam,</p>

<p>I am writing on behalf of <strong>Insurtech Solutions S.r.l.</strong>, an Italian Managing General Agent specialising in surety bonds and guarantees (<em>cauzioni e fideiussioni</em> — Class 15 under the Italian Insurance Code), to introduce our company and explore a potential partnership with <strong>Tokio Marine HCC</strong>.</p>

<p>We are reaching out to Tokio Marine HCC as our preferred capacity partner, recognising your outstanding <strong>A++ (Superior) AM Best rating</strong>, your established leadership in delegated underwriting authority models across Europe, and your proven appetite for specialised MGA partnerships in the surety space.</p>

<h3>About Us</h3>

<p>Insurtech Solutions S.r.l. is an Italian-based MGA currently in the launch phase, built by a team of seasoned surety and insurance professionals with deep expertise in the Italian guarantee market. Our mission is to deliver best-in-class underwriting, distribution, and service in a segment that remains underserved by traditional carriers in Italy.</p>

<p>Our core strengths include:</p>
<ul>
<li><strong>Deep knowledge of the Italian surety regulatory framework</strong>, including the recently enacted Public Procurement Code (<em>D.Lgs 36/2023 — Codice dei Contratti Pubblici</em>) and related guarantee requirements</li>
<li><strong>A growing distribution network</strong> of specialised insurance brokers and intermediaries across Italy, managed in full compliance with IVASS Regulation No. 40/2018 on insurance distribution</li>
<li><strong>Advanced technical underwriting capabilities</strong>, supported by proprietary risk-scoring models, financial analysis tools, and a fully digital operating platform</li>
<li><strong>A dedicated, specialist team</strong> covering the entire operational cycle: underwriting, risk analysis, policy issuance, claims handling, compliance (AML/KYC), and broker relationship management</li>
</ul>

<h3>Our Value Proposition</h3>

<p>We believe a partnership with Tokio Marine HCC would combine the strength of your capacity, global reputation, and surety expertise with our local market knowledge, distribution reach, and operational agility. Specifically, we offer:</p>

<ol>
<li><strong>Market Access</strong> — Immediate access to the Italian surety market through an established and expanding broker network, with particular focus on SMEs and mid-market contractors</li>
<li><strong>Regulatory Expertise</strong> — Full compliance management under Italian and EU regulations, including IVASS supervisory requirements, anti-money laundering obligations (<em>D.Lgs 231/2007</em>), and GDPR</li>
<li><strong>Specialised Product Range</strong> — A comprehensive surety product portfolio tailored to Italian market needs:
    <ul>
    <li><strong>Public procurement bonds</strong> (<em>cauzioni per appalti pubblici</em>) — bid bonds, performance bonds, advance payment guarantees, and maintenance bonds as required under <em>D.Lgs 36/2023</em></li>
    <li><strong>Real estate guarantees</strong> (<em>fideiussioni immobiliari</em>) — buyer protection guarantees under <em>D.Lgs 122/2005</em></li>
    <li><strong>Tax and fiscal guarantees</strong> (<em>cauzioni fiscali</em>) — VAT refund bonds, excise duty guarantees, and customs bonds</li>
    <li><strong>Commercial and contractual guarantees</strong> — rent guarantees, supply contract bonds, and other bespoke surety products</li>
    </ul>
</li>
<li><strong>Operational Excellence</strong> — A lean, technology-enabled operating model designed for efficient policy administration, transparent bordereaux reporting, and proactive portfolio management</li>
<li><strong>Alignment of Interests</strong> — A commitment to disciplined underwriting, prudent risk selection, and long-term profitability</li>
</ol>

<h3>The Italian Surety Market Opportunity</h3>

<p>The Italian surety market represents a significant and growing opportunity, driven by:</p>
<ul>
<li><strong>National Recovery and Resilience Plan (PNRR)</strong> investments exceeding €190 billion, generating substantial demand for public procurement bonds</li>
<li><strong>Regulatory reform</strong> through the new Public Procurement Code (<em>D.Lgs 36/2023</em>), which has modernised guarantee requirements</li>
<li><strong>Limited competition</strong> from specialised MGA players, creating space for a focused, high-quality entrant</li>
<li><strong>Strong cultural demand</strong> for surety bonds across public and private sectors, deeply embedded in Italian business practice</li>
</ul>

<p>Given Tokio Marine HCC's existing presence in Europe via <strong>LPS (Freedom of Services)</strong> and your demonstrated commitment to the delegated authority model, we see an ideal strategic fit.</p>

<h3>Our Request</h3>

<p>We would welcome the opportunity to arrange an <strong>introductory meeting or video call</strong> with your Surety Division and/or Delegated Authority Team to:</p>
<ul>
<li>Present our business plan, target portfolio, and underwriting guidelines in detail</li>
<li>Discuss potential DUA structures, capacity arrangements, and risk appetite alignment</li>
<li>Explore the commercial and operational framework for a mutually beneficial partnership</li>
</ul>

<p>We are flexible on timing and format, and would be pleased to travel to your offices in London or arrange a virtual meeting at your convenience.</p>

<p>Our founding team brings together extensive combined experience in Italian surety underwriting, insurance distribution, and MGA operations. We would be happy to share detailed CVs, our business plan, and financial projections upon request.</p>

<p>We are confident that a partnership with Tokio Marine HCC would create significant value for both parties, and we look forward to the opportunity to discuss this further.</p>

<p>Thank you for your time and consideration.</p>

<p>Yours sincerely,</p>

<div class="signature">
<p><strong>[NOME]</strong><br/>
<em>[TITOLO — CEO / Managing Director]</em><br/>
Insurtech Solutions S.r.l.<br/>
[TELEFONO]<br/>
[EMAIL]<br/>
https://insurtechsolutions.it</p>
</div>

</div>
</div>
</div>
"""

# ─── Email 2: Liberty Mutual Surety ───────────────────────────────────────────

email_liberty = """
<div class="email-block">
<div class="company-header">
<h1>2. LIBERTY MUTUAL SURETY</h1>
<p class="subtitle">Liberty Specialty Markets — Surety Division London | European Distribution Team</p>
<p class="meta">Rating: A AM Best / A2 Moody's &nbsp;|&nbsp; Sede: USA / Londra &nbsp;|&nbsp; Operatività Italia: LPS (tramite Liberty Specialty Markets)</p>
</div>

<div class="email-content">

<table class="email-meta">
<tr><td class="label">From:</td><td>[NOME COGNOME], CEO — Insurtech Solutions S.r.l.</td></tr>
<tr><td class="label">To:</td><td>European Surety Division / Global MGA Partnerships — Liberty Mutual Surety, London</td></tr>
<tr><td class="label">Date:</td><td>[DATA]</td></tr>
<tr><td class="label">Subject:</td><td><strong>MGA Partnership Proposal — Italian Surety Market (Ramo 15 — Cauzioni/Fideiussioni)</strong></td></tr>
</table>

<div class="email-body">

<p>Dear Sir/Madam,</p>

<p>I am writing on behalf of <strong>Insurtech Solutions S.r.l.</strong>, a newly established Italian Managing General Agent specialising exclusively in the <strong>surety and bond line of business (Ramo 15)</strong>, to explore the opportunity of a strategic partnership with <strong>Liberty Mutual Surety</strong>.</p>

<p>Liberty Mutual's unparalleled position as the <strong>world's largest surety provider</strong>, combined with your <strong>A (Excellent) AM Best rating</strong>, extensive global capacity, and proven track record of successful MGA partnerships, makes you an ideal capacity partner for our venture. We believe a collaboration would create significant value for both parties by unlocking access to the <strong>Italian surety market</strong> — a market with substantial and growing demand, yet one that requires deep local expertise and relationships to navigate effectively.</p>

<h3>Who We Are</h3>

<p><strong>Insurtech Solutions S.r.l.</strong> (https://insurtechsolutions.it) is an Italian MGA authorised under the <strong>IVASS regulatory framework</strong> (in accordance with Regulation No. 40/2018 on insurance distribution). Our founding team brings together decades of combined experience in:</p>

<ul>
<li><strong>Surety underwriting</strong> — risk selection, pricing, and portfolio management specific to the Italian market</li>
<li><strong>Broker network management</strong> — established relationships with a growing network of licensed Italian intermediaries</li>
<li><strong>Regulatory and compliance expertise</strong> — full alignment with Italian and EU requirements, including AML/KYC obligations under D.Lgs 231/2007 and the Italian Insurance Code (D.Lgs 209/2005)</li>
<li><strong>Operational excellence</strong> — end-to-end digital workflows from submission to policy issuance, claims handling, and bordereaux reporting</li>
</ul>

<p>We have built a dedicated, specialist team covering underwriting, risk analysis, document management, compliance, broker relations, finance, and claims — ensuring a fully integrated surety operation from day one.</p>

<h3>The Italian Surety Market Opportunity</h3>

<p>Italy represents one of the <strong>largest surety markets in Europe</strong>, driven by structural demand across several key segments:</p>

<ol>
<li><strong>Public Procurement Bonds (Cauzioni per Appalti Pubblici)</strong> — The new Italian Public Contracts Code (<strong>D.Lgs 36/2023</strong>) mandates performance and bid bonds for all public works, services, and supply contracts. With Italy's <strong>PNRR (National Recovery and Resilience Plan)</strong> driving €191.5 billion in public investment through 2026, demand for contract surety bonds is at historic highs.</li>
<li><strong>Real Estate Bonds (Fideiussioni Immobiliari)</strong> — Under <strong>D.Lgs 122/2005</strong>, developers are required to provide advance payment guarantees to property buyers.</li>
<li><strong>Tax and Customs Bonds (Cauzioni Fiscali e Doganali)</strong> — Italian tax authorities and customs agencies routinely require surety bonds to secure deferred VAT payments, excise duties, and customs operations.</li>
<li><strong>Commercial and Contractual Bonds</strong> — Guarantees for private-sector contracts, supply agreements, concessions, and regulatory obligations.</li>
</ol>

<p>The Italian surety market is estimated at over <strong>€1.5 billion in annual gross written premiums</strong>, with room for new entrants offering competitive capacity, efficient service, and specialist expertise.</p>

<h3>Why a Local MGA Is the Optimal Market Entry Strategy</h3>

<p>Liberty Mutual Surety's global expertise and capacity are formidable. However, the Italian surety market presents specific challenges that make a <strong>local MGA model</strong> the most effective entry strategy:</p>

<ul>
<li><strong>Regulatory navigation</strong> — IVASS oversight, Italian-language documentation requirements, and specific product regulations demand a locally licensed operation. Our team ensures full adherence to all Italian regulatory obligations, including Reg. IVASS 40/2018 (distribution), D.Lgs 231/2007 (AML), and sector-specific mandates.</li>
<li><strong>Broker and client relationships</strong> — The Italian surety market is intermediary-driven. Our growing broker network provides immediate market access.</li>
<li><strong>Underwriting localisation</strong> — Italian surety underwriting requires expertise in local financial statements (<em>bilanci civilistici</em>), Italian corporate structures, public procurement procedures, and the specific legal framework governing fideiussioni.</li>
<li><strong>Speed to market</strong> — An MGA partnership allows Liberty Mutual to <strong>begin writing Italian surety business within months</strong>, with controlled risk and full operational support.</li>
<li><strong>Capital efficiency</strong> — The MGA model enables deployment of capacity into a new market with <strong>minimal fixed costs</strong>.</li>
</ul>

<h3>Our Value Proposition</h3>

<table class="value-table">
<tr><th>Area</th><th>What We Deliver</th></tr>
<tr><td>Market Access</td><td>Established and expanding Italian broker network; immediate deal flow</td></tr>
<tr><td>Underwriting</td><td>Specialist Italian surety underwriting; disciplined risk selection and pricing</td></tr>
<tr><td>Compliance</td><td>Full IVASS, AML/KYC, GDPR compliance; regulatory reporting</td></tr>
<tr><td>Operations</td><td>End-to-end policy lifecycle management; digital-first processes</td></tr>
<tr><td>Reporting</td><td>Transparent bordereaux, portfolio analytics, loss reporting to your standards</td></tr>
<tr><td>Claims</td><td>Local claims handling including escussioni (bond calls), recovery (rivalsa), and legal coordination</td></tr>
</table>

<h3>What We Are Looking For</h3>

<p>We are seeking a <strong>capacity partnership</strong> structured as a delegated underwriting authority (MGA/binding authority) arrangement. Key elements we would like to discuss include:</p>
<ul>
<li>Line size and aggregate capacity for the Italian surety book</li>
<li>Product scope — contract surety, commercial bonds, real estate bonds, fiscal/customs bonds</li>
<li>Underwriting authority limits and referral protocols</li>
<li>Commission and fee structure</li>
<li>Reporting cadence and format (bordereaux, portfolio reviews, stewardship)</li>
<li>Duration and renewal terms of the MGA agreement</li>
</ul>

<h3>Next Steps</h3>

<p>We would welcome the opportunity to present our business plan, team, and market analysis in detail during a <strong>video call or in-person meeting</strong> at your convenience — whether at your London offices, at our headquarters in Italy, or at an upcoming industry event.</p>

<p>Thank you for considering this proposal. We are confident that a partnership between Liberty Mutual Surety and Insurtech Solutions would create a compelling platform for profitable surety growth in Italy — combining your world-class capacity and brand with our local expertise, relationships, and operational capability.</p>

<p>We look forward to hearing from you.</p>

<p>Kind regards,</p>

<div class="signature">
<p><strong>[NOME]</strong><br/>
<em>[TITOLO — CEO / Managing Director]</em><br/>
Insurtech Solutions S.r.l.<br/>
[TELEFONO]<br/>
[EMAIL]<br/>
https://insurtechsolutions.it</p>
</div>

</div>
</div>
</div>
"""

# ─── Email 3: Zurich Insurance Group ──────────────────────────────────────────

email_zurich = """
<div class="email-block">
<div class="company-header">
<h1>3. ZURICH INSURANCE GROUP</h1>
<p class="subtitle">Surety &amp; Credit Division — Zurich | Trade Credit &amp; Surety Italy</p>
<p class="meta">Rating: AA- S&P / A+ AM Best &nbsp;|&nbsp; Sede: Svizzera &nbsp;|&nbsp; Operatività Italia: Sede diretta (Zurich Insurance Company Ltd — Rappresentanza Italia)</p>
</div>

<div class="email-content">

<table class="email-meta">
<tr><td class="label">From:</td><td>[NOME COGNOME], CEO — Insurtech Solutions S.r.l.</td></tr>
<tr><td class="label">To:</td><td>Surety &amp; Credit Division / Trade Credit &amp; Surety Italy — Zurich Insurance Group</td></tr>
<tr><td class="label">Date:</td><td>[DATA]</td></tr>
<tr><td class="label">Subject:</td><td><strong>Proposta di Partnership MGA — Ramo Cauzioni (Ramo 15) — Mercato Italiano</strong></td></tr>
</table>

<div class="email-body">

<p>Gentili Signori,</p>

<p>mi rivolgo a Voi a nome di <strong>Insurtech Solutions S.r.l.</strong>, Managing General Agent italiana specializzata nel <strong>ramo cauzioni e fideiussioni (Ramo 15)</strong>, per presentare la nostra società e proporre un'esplorazione congiunta di una potenziale partnership con <strong>Zurich Insurance Group</strong>.</p>

<p>Zurich rappresenta per noi un interlocutore di primario interesse, sia per l'eccellente solidità finanziaria confermata dal <strong>rating AA- S&P e A+ AM Best</strong>, sia per la Vostra significativa presenza diretta nel mercato assicurativo italiano e per il <strong>volume di premi surety tra i più elevati in Europa</strong> (stimato in €400-500M). Riteniamo che una collaborazione strutturata possa generare valore significativo per entrambe le parti, espandendo la Vostra capacità distributiva nel ramo cauzioni attraverso un partner specializzato e tecnologicamente avanzato.</p>

<h3>Chi Siamo</h3>

<p><strong>Insurtech Solutions S.r.l.</strong> (https://insurtechsolutions.it) è una MGA italiana di nuova costituzione, progettata fin dall'origine come piattaforma operativa specializzata nel ramo cauzioni. Il nostro team fondatore riunisce competenze profonde e complementari nel mercato italiano delle garanzie:</p>

<ul>
<li><strong>Sottoscrizione specialistica</strong> — Underwriter dedicati con esperienza diretta nella valutazione del merito creditizio di imprese italiane, PMI e operatori del settore costruzioni e servizi</li>
<li><strong>Analisi del rischio</strong> — Modelli proprietari di scoring finanziario calibrati sulle specificità contabili italiane (bilanci civilistici, Centrale Rischi, banche dati Cerved, visure camerali)</li>
<li><strong>Compliance e normativa</strong> — Piena conformità al quadro regolamentare italiano: Regolamento IVASS 40/2018 (distribuzione), D.Lgs 231/2007 (antiriciclaggio), D.Lgs 209/2005 (Codice delle Assicurazioni Private), GDPR</li>
<li><strong>Gestione operativa end-to-end</strong> — Piattaforma digitale per l'intero ciclo di vita della polizza: dall'acquisizione della richiesta all'emissione, dalla gestione dei rinnovi alla liquidazione sinistri (escussioni)</li>
<li><strong>Rete distributiva</strong> — Network di broker specializzati nel comparto cauzioni, in costante espansione sul territorio nazionale</li>
</ul>

<h3>L'Opportunità nel Mercato Cauzioni Italiano</h3>

<p>Il mercato italiano delle cauzioni rappresenta un'opportunità strutturale di grande rilevanza, con premi annui stimati superiori a <strong>€1,5 miliardi</strong> e una domanda sostenuta da molteplici fattori:</p>

<ul>
<li><strong>Appalti pubblici (D.Lgs 36/2023)</strong> — Il nuovo Codice dei Contratti Pubblici impone cauzioni provvisorie e definitive per tutti gli appalti di lavori, servizi e forniture. Il Piano Nazionale di Ripresa e Resilienza (PNRR), con investimenti superiori a €190 miliardi, sta generando una domanda senza precedenti di garanzie fideiussorie per appalti pubblici.</li>
<li><strong>Fideiussioni immobiliari (D.Lgs 122/2005)</strong> — L'obbligo di garanzia a tutela degli acquirenti di immobili in costruzione crea un flusso costante e ricorrente di domanda.</li>
<li><strong>Cauzioni fiscali e doganali</strong> — Rimborsi IVA, accise, operazioni doganali: un segmento stabile e a basso rischio che arricchisce il mix di portafoglio.</li>
<li><strong>Garanzie commerciali e contrattuali</strong> — Cauzioni per contratti privati, concessioni, obblighi regolamentari e fideiussioni per locazioni.</li>
</ul>

<h3>Perché Zurich — Un Allineamento Strategico Naturale</h3>

<p>Abbiamo identificato Zurich Insurance Group come partner ideale per diversi motivi specifici:</p>

<ol>
<li><strong>Presenza diretta in Italia</strong> — A differenza di molti competitor internazionali che operano solo in LPS, Zurich dispone di una <strong>rappresentanza diretta in Italia</strong> con un team dedicato al surety. Questo facilita enormemente la strutturazione operativa di una partnership MGA, riducendo complessità regolamentari e tempi di implementazione.</li>
<li><strong>Leadership europea nel surety</strong> — Con un volume di premi cauzioni stimato tra €400M e €500M, Zurich è tra i principali operatori surety europei. La capacità e la profondità di esperienza nel ramo sono garanzia di solidità per i nostri obbligatari e per la rete distributiva.</li>
<li><strong>Complementarità distributiva</strong> — Un modello MGA consentirebbe a Zurich di <strong>ampliare la propria copertura distributiva</strong> nel ramo cauzioni italiano, raggiungendo segmenti di mercato (PMI, mid-market, specifiche aree geografiche) attualmente non serviti attraverso i canali diretti.</li>
<li><strong>Solidità finanziaria</strong> — Il rating <strong>AA- di S&P</strong> è un asset competitivo fondamentale nel mercato italiano delle cauzioni, in particolare per le garanzie richieste nelle gare d'appalto pubbliche, dove la solidità dell'emittente è criterio di valutazione.</li>
</ol>

<h3>La Nostra Proposta</h3>

<p>Proponiamo l'esplorazione di un <strong>accordo di delega assuntiva (Delegated Underwriting Authority)</strong> strutturato come segue:</p>

<table class="value-table">
<tr><th>Elemento</th><th>Proposta</th></tr>
<tr><td>Delega assuntiva</td><td>Sottoscrizione delegata entro parametri concordati di risk appetite, limiti e pricing</td></tr>
<tr><td>Prodotti</td><td>Cauzioni per appalti pubblici (provvisorie/definitive), fideiussioni immobiliari (D.Lgs 122/2005), cauzioni fiscali/doganali, garanzie commerciali</td></tr>
<tr><td>Distribuzione</td><td>Rete di broker specializzati cauzioni, gestita e sviluppata da Insurtech Solutions</td></tr>
<tr><td>Reporting</td><td>Bordereaux mensili, review trimestrali del portafoglio, pianificazione strategica annuale</td></tr>
<tr><td>Compliance</td><td>Gestione integrale IVASS, AML/KYC, Codice Appalti, GDPR a carico del nostro team dedicato</td></tr>
<tr><td>Sinistri</td><td>Gestione escussioni in prima linea con supervisione e autorità di Zurich su riserve e pagamenti</td></tr>
</table>

<h3>Sinergie con la Presenza Zurich in Italia</h3>

<p>Siamo consapevoli della Vostra struttura italiana e riteniamo che la collaborazione possa generare sinergie concrete:</p>
<ul>
<li><strong>Cross-referral</strong> — I clienti corporate di Zurich Italia con esigenze di cauzioni potrebbero essere serviti attraverso la nostra piattaforma specializzata, mantenendo il business all'interno del Gruppo</li>
<li><strong>Emissione sotto brand Zurich</strong> — Le polizze potrebbero essere emesse sotto il marchio Zurich, valorizzando la brand recognition nel mercato italiano</li>
<li><strong>Efficienza operativa</strong> — Il nostro modello digitale consente tempi di emissione rapidi e costi operativi contenuti, a beneficio della redditività complessiva del ramo</li>
</ul>

<h3>Prossimi Passi</h3>

<p>Saremmo lieti di presentare il nostro business plan e discutere nel dettaglio la potenziale partnership in occasione di un <strong>incontro conoscitivo</strong>, che potremo organizzare:</p>
<ul>
<li>Presso i Vostri uffici a Zurigo o presso la Vostra sede italiana</li>
<li>Presso la nostra sede in Italia</li>
<li>In videoconferenza, secondo la Vostra preferenza</li>
</ul>

<p>Siamo disponibili a fornire su richiesta:</p>
<ul>
<li>Business plan dettagliato con proiezioni triennali</li>
<li>Linee guida di sottoscrizione e framework di risk appetite</li>
<li>CV dei membri chiave del team</li>
<li>Demo della piattaforma tecnologica</li>
<li>Documentazione di compliance e governance</li>
</ul>

<p>Siamo certi che una partnership tra Zurich Insurance Group e Insurtech Solutions possa rappresentare un'opportunità di crescita profittevole nel mercato cauzioni italiano, e restiamo a disposizione per ogni approfondimento.</p>

<p>In attesa di un Vostro cortese riscontro, porgiamo cordiali saluti.</p>

<div class="signature">
<p><strong>[NOME]</strong><br/>
<em>[TITOLO — CEO / Managing Director]</em><br/>
Insurtech Solutions S.r.l.<br/>
[TELEFONO]<br/>
[EMAIL]<br/>
https://insurtechsolutions.it</p>
</div>

</div>
</div>
</div>
"""

# ─── HTML Template ─────────────────────────────────────────────────────────────

html_template = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
@page {{
    size: A4;
    margin: 2cm 2.2cm;
}}

body {{
    font-family: 'Georgia', 'Times New Roman', serif;
    font-size: 10.5pt;
    line-height: 1.55;
    color: #1a1a1a;
}}

/* Cover page */
.cover {{
    page-break-after: always;
    text-align: center;
    padding-top: 8cm;
}}

.cover h1 {{
    font-size: 22pt;
    color: #003366;
    margin-bottom: 0.3cm;
    letter-spacing: 1px;
}}

.cover h2 {{
    font-size: 14pt;
    color: #555;
    font-weight: normal;
    margin-bottom: 1.5cm;
}}

.cover .company-name {{
    font-size: 13pt;
    color: #003366;
    font-weight: bold;
    margin-top: 2cm;
}}

.cover .date {{
    font-size: 11pt;
    color: #777;
    margin-top: 0.5cm;
}}

.cover .confidential {{
    font-size: 9pt;
    color: #999;
    margin-top: 3cm;
    text-transform: uppercase;
    letter-spacing: 2px;
}}

/* Email blocks */
.email-block {{
    page-break-before: always;
}}

.company-header {{
    background: linear-gradient(135deg, #003366, #004080);
    color: white;
    padding: 1cm 1.2cm;
    margin: -2cm -2.2cm 1.2cm -2.2cm;
}}

.company-header h1 {{
    font-size: 16pt;
    margin: 0 0 0.3cm 0;
    letter-spacing: 1px;
}}

.company-header .subtitle {{
    font-size: 10pt;
    margin: 0 0 0.2cm 0;
    opacity: 0.9;
}}

.company-header .meta {{
    font-size: 8.5pt;
    margin: 0;
    opacity: 0.75;
}}

.email-content {{
    padding: 0;
}}

.email-meta {{
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 1cm;
    font-size: 9.5pt;
    background: #f8f9fa;
    border: 1px solid #e0e0e0;
}}

.email-meta td {{
    padding: 0.25cm 0.4cm;
    border-bottom: 1px solid #e8e8e8;
    vertical-align: top;
}}

.email-meta .label {{
    width: 80px;
    font-weight: bold;
    color: #003366;
    white-space: nowrap;
}}

.email-body h3 {{
    font-size: 12pt;
    color: #003366;
    margin-top: 0.8cm;
    margin-bottom: 0.3cm;
    border-bottom: 1px solid #003366;
    padding-bottom: 0.15cm;
}}

.email-body p {{
    margin: 0.3cm 0;
    text-align: justify;
}}

.email-body ul, .email-body ol {{
    margin: 0.3cm 0;
    padding-left: 1.2cm;
}}

.email-body li {{
    margin-bottom: 0.2cm;
}}

.value-table {{
    width: 100%;
    border-collapse: collapse;
    margin: 0.5cm 0;
    font-size: 9.5pt;
}}

.value-table th {{
    background: #003366;
    color: white;
    text-align: left;
    padding: 0.25cm 0.4cm;
    font-weight: bold;
}}

.value-table td {{
    padding: 0.25cm 0.4cm;
    border-bottom: 1px solid #ddd;
    vertical-align: top;
}}

.value-table tr:nth-child(even) td {{
    background: #f8f9fa;
}}

.signature {{
    margin-top: 1cm;
    padding-top: 0.5cm;
    border-top: 1px solid #ccc;
}}

.signature p {{
    line-height: 1.4;
}}

/* Footer */
.page-footer {{
    font-size: 8pt;
    color: #999;
    text-align: center;
}}
</style>
</head>
<body>

<!-- Cover Page -->
<div class="cover">
<h1>BOZZE DI PRIMO CONTATTO</h1>
<h2>Top 3 Compagnie Surety — Partnership MGA</h2>

<div class="company-name">INSURTECH SOLUTIONS S.r.l.</div>
<div>Managing General Agent — Ramo 15 Cauzioni/Fideiussioni</div>
<div class="date">Febbraio 2026</div>

<div style="margin-top: 2cm; font-size: 9.5pt; color: #555;">
<p><strong>Compagnie destinatarie:</strong></p>
<p>1. Tokio Marine HCC (A++ AM Best) — Regno Unito/Giappone</p>
<p>2. Liberty Mutual Surety (A AM Best) — USA/Regno Unito</p>
<p>3. Zurich Insurance Group (AA- S&P) — Svizzera/Italia</p>
</div>

<div class="confidential">Documento riservato — Ad uso interno</div>
</div>

<!-- Email 1: Tokio Marine HCC -->
{email_tokio}

<!-- Email 2: Liberty Mutual Surety -->
{email_liberty}

<!-- Email 3: Zurich Insurance Group -->
{email_zurich}

</body>
</html>
"""

# Generate PDF
print("Generating PDF...")
html = HTML(string=html_template)
html.write_pdf('output/bozze_contatto_top3_surety.pdf')
print("PDF generated successfully: output/bozze_contatto_top3_surety.pdf")

# Quick word count check
import re
def count_words(text):
    clean = re.sub(r'<[^>]+>', ' ', text)
    return len(clean.split())

print(f"\nWord counts:")
print(f"  Email 1 (Tokio Marine HCC): ~{count_words(email_tokio)} words")
print(f"  Email 2 (Liberty Mutual):   ~{count_words(email_liberty)} words")
print(f"  Email 3 (Zurich):           ~{count_words(email_zurich)} words")
