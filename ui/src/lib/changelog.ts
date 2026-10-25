/**
 * "Novità" — what changed in the app, newest first.
 *
 * Shown on /changelog and, for `highlight` entries the person has not seen
 * yet, in the What's new bar at the top. Seen state is kept
 * per entry id (see hooks/use-whats-new.ts), so ids must never change once
 * shipped. Add new entries at the top.
 */

export type ChangelogKind = "new" | "improved" | "fixed";

export interface ChangelogEntry {
  /** Stable id — used to remember what the person has already seen. */
  id: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  kind: ChangelogKind;
  title: string;
  /** One line, shown in the banner. */
  summary: string;
  /** Markdown, shown on the changelog page. */
  body: string;
  /** Promote in the What's new banner until seen. */
  highlight?: boolean;
  cta?: { label: string; to: string };
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: "2026-10-25-mcp-agent-card",
    date: "2026-10-25",
    kind: "new",
    title: "La scheda dell'agente dentro Claude e ChatGPT",
    summary: "Chiedi a Claude come sta andando un agente: risponde con una scheda interattiva di Polpo.",
    body: [
      "Con il connettore MCP, quando chiedi di un agente Claude e ChatGPT mostrano la sua **scheda** direttamente nella chat:",
      "",
      "- se sta lavorando, il task in corso e il bilancio di oggi;",
      "- la prossima cosa in programma e l'obiettivo principale, con l'avanzamento;",
      "- **Apri** la porta a schermo intero, con task, obiettivi e routine: le proposte dell'agente si confermano o si annullano da lì;",
      "- **Chiedi un aggiornamento** fa parlare Claude con l'agente.",
      "",
      "Segue il tema chiaro o scuro di Claude e funziona anche da telefono.",
    ].join("\n"),
  },
  {
    id: "2026-10-25-artifacts",
    date: "2026-10-25",
    kind: "new",
    title: "Artefatti: documenti, dashboard e design",
    summary: "Chiedi una dashboard sui tuoi dati, un documento o un design: gli agenti li creano come artefatti, sempre a portata di mano.",
    body: [
      "Al posto delle **Views** c'è la sezione **Artifacts**, con tutto quello che gli agenti (e tu) create per guardarlo e tenerlo:",
      "",
      "- **Dashboard** in HTML sui tuoi dati veri, che si aggiornano da sole.",
      "- **Documenti** (Markdown), **design** e piccole **app**, **diagrammi** e **disegni**.",
      "- **Versioni**: ogni modifica tiene la precedente, e puoi tornare indietro.",
      "- In chat, una scheda per ogni artefatto creato: si apre accanto alla conversazione.",
      "",
      "Le pagine girano isolate e leggono i dati con i permessi di chi le ha create. Le vecchie Views sono ancora lì, tra gli artefatti, segnate come **Legacy**: per i nuovi cruscotti usa le dashboard.",
    ].join("\n"),
    highlight: true,
    cta: { label: "Apri gli artefatti", to: "/artifacts" },
  },
  {
    id: "2026-10-25-mcp-connector",
    date: "2026-10-25",
    kind: "new",
    title: "Polpo come connettore MCP",
    summary: "Usa Polpo da Claude Code, Codex, Claude Desktop o Cursor: chiedi a Polpo, parla con gli agenti, segui task, dati e file.",
    body: [
      "Ogni server Polpo è anche un **server MCP** su `/mcp`: lo colleghi a Claude Code, Codex, Cursor e agli altri client MCP con la tua chiave API, oppure come **connettore personalizzato** in Claude e ChatGPT, con un accesso (OAuth) invece della chiave.",
      "",
      "- **ask_polpo**: chiedi qualsiasi cosa a Polpo, come in chat.",
      "- **chat_with_agent**: parla con un agente.",
      "- **File**: sfoglia, cerca, leggi (testi, immagini e PDF) e scrivi i file dell'istanza.",
      "- Task, missioni, artefatti, dati e approvazioni, più l'accesso a tutte le operazioni dell'API.",
      "",
      "Puoi rendere pubblico solo il connettore, con una **chiave MCP** dedicata (`POLPO_MCP_KEY`), e tenere privati la dashboard e le API.",
      "",
      "La guida con la configurazione per ogni client è in `docs/mcp.md`.",
    ].join("\n"),
  },
  {
    id: "2026-10-15-deltapolpo-fixes",
    date: "2026-10-15",
    kind: "fixed",
    title: "Missioni, playbook e modelli locali: tante correzioni",
    summary: "Playbook che partono, missioni che si chiudono, dashboard che si aggiorna e modelli locali, anche nel setup.",
    body: [
      "- **Modelli locali**: i task degli agenti usano anche i provider personalizzati (Ollama, LM Studio, gateway), non solo la chat. Al primo avvio puoi scegliere un *modello locale (offline)*, senza account né chiavi.",
      "- **Playbook**: c'è il pulsante **Run**, e partono anche quelli con checkpoint e attese.",
      "- **Missioni**: ogni lancio di un playbook è una missione a sé; le pause ai checkpoint sopravvivono al riavvio; le missioni si chiudono e si interrompono correttamente.",
      "- **Un'attesa scritta male** (come `PT1s`) non blocca più tutte le missioni.",
      "- **Dashboard**: la pagina della missione e le Approvazioni si aggiornano da sole, e la lista agenti mostra subito le modifiche.",
      "- **App desktop**: la lista dei modelli in *Aggiungi agente* non è più vuota.",
      "- **Vocali su Telegram in privato**: vengono trascritti appena arrivano, come nei gruppi, e il testo resta nella conversazione. Prima Polpo poteva \"perdere\" il contenuto del vocale al messaggio successivo.",
      "",
      "Grazie a **DeltaM128**, che ha trovato e corretto gran parte di questi problemi.",
    ].join("\n"),
  },
  {
    id: "2026-10-14-drive-routine",
    date: "2026-10-14",
    kind: "improved",
    title: "Agenti con una routine",
    summary: "Gli agenti con uno scopo si costruiscono una routine e la adattano ai loro obiettivi e ai loro task.",
    body: [
      "Un agente con uno scopo ora si costruisce una **routine**: i momenti fissi che servono ai suoi obiettivi, come un check-in al mattino, la chiusura a fine giornata o il piano della settimana.",
      "",
      "- La imposta alla prima riflessione, senza duplicare quello che fa già.",
      "- La rivede ogni settimana e quando cambiano i suoi obiettivi o i suoi **task**, che ora vede quando riflette.",
      "- Nella scheda **Goals** i momenti ricorrenti hanno l'etichetta *Routine*.",
    ].join("\n"),
  },
  {
    id: "2026-10-13-desktop-tasks",
    date: "2026-10-13",
    kind: "fixed",
    title: "App desktop: i task partono",
    summary: "Nell'app desktop i task ora partono, e il login con abbonamento ai provider funziona.",
    body: [
      "- **I task partono**: nell'app desktop nessun task riusciva ad avviarsi; ora funzionano come sul server.",
      "- **Login con abbonamento**: l'accesso ai provider si apre nel browser di sistema e va a buon fine.",
      "- **Dopo il primo setup** non serve più riavviare: i task partono e la dashboard si aggiorna subito.",
      "",
      "Grazie a **DeltaM128**, che ha trovato e corretto questi problemi.",
    ].join("\n"),
  },
  {
    id: "2026-10-13-agent-drive",
    date: "2026-10-13",
    kind: "new",
    title: "Agenti con uno scopo",
    summary: "Dai a un agente uno scopo: si muove da solo, si ricorda delle persone e sceglie quando farsi sentire.",
    body: [
      "Nella scheda **Goals** di un agente puoi dargli uno **scopo** e degli **obiettivi**. Per esempio: \"essere l'health coach di Alessio\".",
      "",
      "- **Ci pensa da solo**: ripassa le sue chat e i gruppi (anche quello che legge senza essere chiamato) e decide se scrivere, a chi, o cosa programmare.",
      "- **Si ricorda delle persone**: se senti \"oggi è il compleanno di Grazia\", il giorno dopo le fa gli auguri.",
      "- **Ha una personalità sua** e la porta avanti: la trovi in *Who it is*, e puoi correggerla.",
      "- **Si dà degli obiettivi a cascata**: dallo scopo a 6–12 mesi, trimestre, mese, settimana e giorno, misurabili e con i passi da fare. Ogni mattina pianifica la giornata, e a inizio settimana, mese e trimestre fa il punto.",
      "- **Cresce**: si chiede cosa potrebbe fare meglio e cosa gli manca, lo studia e si scrive le sue skill.",
      "- **Autonomia a scelta**: propone e aspetta il tuo sì, agisce da solo sulle cose leggere, oppure decide in tutto.",
      "",
      "Quello che ha in programma e le sue riflessioni sono sempre visibili, e puoi approvare o annullare.",
    ].join("\n"),
    highlight: true,
    cta: { label: "Vai agli agenti", to: "/agents" },
  },
  {
    id: "2026-10-13-send-anywhere",
    date: "2026-10-13",
    kind: "new",
    title: "Agenti liberi di scrivere ovunque",
    summary: "Messaggi e promemoria verso qualsiasi gruppo o persona, subito, a un'ora precisa o ricorrenti.",
    body: [
      "Agenti e Polpo ora scrivono in **qualsiasi chat** di Telegram, da dovunque glielo chiedi (web, privato o un altro gruppo):",
      "",
      "- \"Scrivi al gruppo **Marketing** che la release è uscita\": il messaggio parte subito.",
      "- \"Ogni lunedì alle 9 ricorda al gruppo la riunione\": promemoria ricorrente, anche con orari cron.",
      "- \"Domani alle 8 manda a Marco il riepilogo\": una volta sola, all'ora che dici.",
      "",
      "Se il bot dell'agente non è in quel gruppo, il messaggio lo manda un altro bot dell'istanza.",
    ].join("\n"),
    highlight: true,
  },
  {
    id: "2026-10-12-polpo-knows-agents",
    date: "2026-10-12",
    kind: "improved",
    title: "Polpo sa cosa sanno fare gli agenti",
    summary: "Chiedi a Polpo di far imparare un agente, cosa ha imparato o di annullarlo: ora lo sa fare.",
    body: [
      "Polpo ora conosce le capacità degli agenti nelle chat (**apprendimento**, **controlli ricorrenti**, **risposte vocali**, **reazioni**) e le gestisce per te:",
      "",
      "- \"Fai imparare **Marco** dalle sue chat\": attiva l'apprendimento dell'agente.",
      "- \"Cosa ha imparato Marco?\": mostra le modifiche a memoria e skill.",
      "- \"Fallo ripassare adesso\" o \"annulla quella modifica\": avvia una revisione o la annulla.",
      "",
      "Anche gli agenti sanno di poter programmare un controllo invece di promettere di avvisarti, e di poter cambiare da soli apprendimento e voce quando glielo chiedi.",
    ].join("\n"),
  },
  {
    id: "2026-10-12-no-empty-replies",
    date: "2026-10-12",
    kind: "fixed",
    title: "Basta \"nothing to say\" su Telegram",
    summary: "Quando un agente usava degli strumenti e poi chiudeva senza scrivere, arrivava \"…has nothing to say\". Ora gli viene chiesto di rispondere.",
    body: [
      "Succedeva soprattutto dopo che l'agente (o Polpo) aveva usato degli strumenti: il modello chiudeva il turno **senza scrivere niente**, e su Telegram arrivava \"…processed your request but has nothing to say\".",
      "",
      "- Ora, se un turno finisce **senza risposta**, Polpo chiede al modello di scriverla subito: cosa ha fatto, cosa ha trovato o cosa gli serve.",
      "- Se l'agente arriva al **limite di passaggi**, invece di fermarsi in silenzio riassume cosa ha fatto e cosa resta da fare. Su Telegram Polpo ora ha più passaggi a disposizione (da 15 a 40).",
      "- Nel raro caso in cui resti comunque vuoto, il messaggio spiega cosa è successo e dove guardare.",
    ].join("\n"),
  },
  {
    id: "2026-10-12-agent-learning",
    date: "2026-10-12",
    kind: "new",
    highlight: true,
    title: "Gli agenti imparano dalle conversazioni",
    summary: "Se lo attivi, ogni tanto l'agente rilegge le sue chat e aggiorna la memoria e le sue skill. Puoi sempre annullare.",
    body: [
      "Ogni agente può **imparare dalle sue conversazioni**. È spento di default: lo attivi dalla scheda **Learning** dell'agente, oppure chiedendolo all'agente stesso (\"impara dalle nostre conversazioni\").",
      "",
      "- Ogni **30 messaggi** (nelle sue chat e nei gruppi), o dopo **30 minuti** di pausa, l'agente rilegge quello che si è detto con il suo modello.",
      "- Tiene aggiornata la **memoria**: preferenze, decisioni, correzioni che gli hai fatto. Toglie ciò che non vale più.",
      "- Quando nota una **procedura ripetuta**, la scrive come **skill sua** e la aggiorna nel tempo. Le skill condivise non le tocca.",
      "- Non salva mai credenziali né dati personali di altre persone.",
      "",
      "Ogni modifica compare nella scheda **Learning** con il prima e il dopo, e si **annulla con un clic**. C'è anche **Review now** per farlo subito.",
    ].join("\n"),
    cta: { label: "Apri gli agenti", to: "/agents" },
  },
  {
    id: "2026-10-11-recurring-checks",
    date: "2026-10-11",
    kind: "new",
    highlight: true,
    title: "Controlli ricorrenti in chat e nei gruppi",
    summary: "\"Controlla ogni 2 minuti se il sito risponde e avvisaci\": ora l'agente lo fa davvero, e scrive solo quando c'è qualcosa da dire.",
    body: [
      "Chiedi a un agente (o a Polpo) di **ripetere un controllo** ogni N minuti, in chat o in un **gruppo Telegram**.",
      "",
      "- Ogni volta l'agente rifà il controllo e **scrive solo se c'è qualcosa da dire**: niente messaggi inutili.",
      "- La risposta arriva **dove l'hai chiesto**: nel gruppo, nel topic o nella chat privata.",
      "- Puoi chiedere un numero massimo di volte o una data di fine; per vederli o fermarli, chiedilo all'agente.",
      "",
      "Prima un agente poteva solo promettere di avvisarti, senza poterlo fare.",
    ].join("\n"),
  },
  {
    id: "2026-10-11-voice-replies",
    date: "2026-10-11",
    kind: "new",
    title: "Risposte vocali su Telegram",
    summary: "Un agente può risponderti con un messaggio vocale: sempre, oppure solo quando gli scrivi con un vocale.",
    body: [
      "Gli agenti (e Polpo) possono rispondere su Telegram con un **vero messaggio vocale**, con il testo come didascalia.",
      "",
      "- **Spento di default**. Si attiva chiedendolo all'agente (\"rispondimi con i vocali\"): sceglie lui tra *mai*, *quando ricevo un vocale* e *sempre*.",
      "- La voce usa OpenAI o ElevenLabs se hai la chiave, altrimenti edge-tts se è installato; senza nessuno dei tre la risposta resta testo.",
    ].join("\n"),
  },
  {
    id: "2026-10-11-reactions",
    date: "2026-10-11",
    kind: "new",
    title: "Reazioni con le emoji",
    summary: "Su Telegram un agente può rispondere con una reazione (👍 🎉 ❤) al tuo messaggio invece di scriverti.",
    body: [
      "Quando basta un cenno (un \"ok grazie\", una buona notizia), l'agente può mettere una **reazione** al tuo messaggio invece di rispondere con un testo.",
      "",
      "Nei gruppi gli altri agenti vedono che ha reagito. Se la chat non permette quella reazione, l'emoji arriva come messaggio.",
    ].join("\n"),
  },
  {
    id: "2026-10-11-model-catalog",
    date: "2026-10-11",
    kind: "improved",
    title: "Polpo conosce tutti i modelli che puoi usare",
    summary: "Chiedi a Polpo quali modelli hai o qual è il più economico: li cerca nel catalogo, anche nei gateway personalizzati.",
    body: [
      "Polpo ora può **cercare nel catalogo dei modelli**: per provider, nome, ragionamento, immagini e costo, mostrando solo quelli per cui hai le credenziali.",
      "",
      "Anche i **gateway personalizzati** (endpoint compatibili OpenAI/Anthropic) contano tra i provider collegati, e Polpo li usa quando sceglie il modello di un agente invece di indovinare.",
    ].join("\n"),
  },
  {
    id: "2026-10-10-group-media",
    date: "2026-10-10",
    kind: "fixed",
    title: "Nei gruppi Telegram gli agenti capiscono foto e vocali",
    summary: "I vocali vengono trascritti e le foto salvate: tutti gli agenti del gruppo li leggono, non più solo [photo].",
    body: [
      "Prima, nei gruppi, gli agenti vedevano solo `[photo]` o `[voice message]`.",
      "",
      "- I **vocali** vengono **trascritti** appena arrivano (con la chiave OpenAI o Deepgram dell'agente) e la trascrizione entra nella conversazione del gruppo.",
      "- Le **foto** e i file vengono salvati una volta e l'agente a cui scrivi le vede direttamente.",
      "- Anche un vocale senza testo può far intervenire un agente, se è per lui.",
    ].join("\n"),
  },
  {
    id: "2026-10-10-desktop",
    date: "2026-10-10",
    kind: "fixed",
    title: "L'app desktop parte su Windows, macOS e Linux",
    summary: "Risolti \"Server Start Failed\" e la finestra bianca; ora ogni versione viene provata installata e usata su tutti i sistemi.",
    body: [
      "- **Server Start Failed** (0.4.0): il server dell'app non trovava due componenti. Risolto in 0.4.1.",
      "- **Finestra bianca** (0.4.2): l'interfaccia non si caricava. Risolto in 0.4.3.",
      "- Se il server non parte, l'errore ora mostra le ultime righe e dove trovare il log completo.",
      "- Prima di ogni rilascio l'app viene **aperta e usata** su Windows (anche dopo l'installazione), macOS e Linux: chat e pagine principali.",
    ].join("\n"),
  },
  {
    id: "2026-10-06-context-compaction",
    date: "2026-10-06",
    kind: "improved",
    title: "Conversazioni lunghe: il contesto si compatta meglio",
    summary: "Chat e task lunghi restano nella finestra del modello senza perdere il filo. Scrivi /compact per farlo quando vuoi.",
    body: [
      "Quando una conversazione o un task si avvicina al limite del modello, Polpo ora **compatta il contesto** in modo più intelligente:",
      "",
      "- prima **svuota i vecchi risultati degli strumenti** (se erano stati salvati su file, resta il percorso);",
      "- poi fa **riassumere da un modello** la parte più vecchia, aggiornando il riassunto precedente invece di rifarlo da capo;",
      "- la **richiesta del task** non viene mai riassunta, e i **fatti importanti** finiscono nella memoria dell'agente.",
      "",
      "Il riassunto resta lo stesso tra una chiamata e l'altra, quindi la cache del modello funziona e si spende meno.",
      "",
      "Scrivi **/compact** in chat (anche su Telegram, con un agente) per compattare subito; puoi aggiungere su cosa concentrarsi, per esempio `/compact le decisioni sul prezzo`. Ogni compattazione compare in **Events**.",
      "",
      "Gli output molto grandi degli strumenti ora vengono **salvati su file** invece di essere tagliati: l'agente vede un'anteprima e il percorso per rileggerli.",
    ].join("\n"),
  },
  {
    id: "2026-10-06-events",
    date: "2026-10-06",
    kind: "improved",
    title: "Activity e Logs diventano Events",
    summary: "Una sola pagina per tutto quello che succede, Live e History, con filtri per tipo di evento e agente.",
    body: [
      "Polpo funziona a **eventi**: ogni cosa che succede (un task che cambia stato, un agente che parte o finisce, una missione, un'approvazione, una notifica…) è un evento.",
      "",
      "- **Events → Live**: gli eventi mentre succedono.",
      "- **Events → History**: gli eventi salvati, per periodo (ultima ora, 24 ore, 7 o 30 giorni) o per singolo avvio del server.",
      "- In entrambe puoi filtrare per **categoria**, **tipo di evento**, **agente**, **esito** (errori, avvisi…) e cercare nel testo.",
      "- I messaggi testuali del server ora si chiamano **System**.",
      "- Nel dettaglio di un task, quello che ha fatto l'agente passo per passo è la scheda **Execution**.",
      "",
      "La trovi nel menu, subito sotto Chat.",
    ].join("\n"),
    cta: { label: "Apri Events", to: "/events" },
  },
  {
    id: "2026-10-06-group-chats",
    date: "2026-10-06",
    kind: "new",
    highlight: true,
    title: "Chat di gruppo con più agenti",
    summary: "Una sola conversazione con te e più agenti: rispondono quando il messaggio è per loro.",
    body: [
      "Ora puoi aprire una conversazione con te e **più agenti insieme**, direttamente dalla Chat.",
      "",
      "- Un agente risponde se lo **menzioni con @nome**, oppure quando il messaggio è per lui: un classificatore veloce decide chi deve rispondere.",
      "- Gli agenti possono rispondere **tutti insieme** o **uno dopo l'altro**, ognuno vedendo la risposta precedente.",
      "- Tutto si regola dalle **impostazioni del gruppo** (l'ingranaggio in alto nella conversazione).",
      "",
      "Per iniziare: nella Chat apri il menu dell'agente (\"Chat with …\") e scegli **Group chat…**, oppure premi **+ → New group** nell'elenco delle conversazioni. I gruppi compaiono in cima allo stesso elenco.",
    ].join("\n"),
    cta: { label: "Crea un gruppo", to: "/chat?newGroup=1" },
  },
  {
    id: "2026-10-06-telegram-groups",
    date: "2026-10-06",
    kind: "new",
    highlight: true,
    title: "Telegram: gli agenti capiscono quando parli con loro",
    summary: "Nei gruppi Telegram gli agenti rispondono anche senza @ quando il messaggio è per loro, e ricordano la conversazione.",
    body: [
      "Nei gruppi Telegram non serve più menzionare sempre l'agente: risponde anche **senza @** quando il messaggio è chiaramente per lui. Un classificatore veloce legge la conversazione e decide chi deve rispondere.",
      "",
      "- Tiene conto del **contesto**: chi c'è nel gruppo, di cosa si stava parlando e chi era già coinvolto.",
      "- Se nel gruppo ci sei **solo tu e un agente**, l'agente risponde sempre.",
      "- Ogni gruppo ha **un unico trascritto**, condiviso da tutti gli agenti: ognuno sa cosa hanno già risposto gli altri e non ripete cose già dette.",
      "- La **soglia** con cui l'agente decide di rispondere è configurabile.",
      "",
      "Serve la **privacy mode disattivata** nel bot (BotFather → /setprivacy → Disable), altrimenti il bot vede solo comandi e risposte.",
    ].join("\n"),
  },
  {
    id: "2026-10-06-sandbox",
    date: "2026-10-06",
    kind: "new",
    title: "Sandbox: gli agenti eseguono i comandi in un ambiente isolato",
    summary: "Scegli dove girano i comandi degli agenti (e di Polpo): questa macchina o una gabbia che vede solo la cartella di lavoro, con rete libera, limitata o assente.",
    highlight: true,
    cta: { label: "Apri Sandbox", to: "/config?section=sandbox" },
    body: [
      "Gli agenti pensano sul server, ma i loro **comandi** (shell, ricerca nei file, script, `run_command` di Polpo) ora girano in una **sandbox**.",
      "",
      "- **Bubblewrap**: una gabbia su questa macchina. Vede solo la cartella di lavoro, i percorsi concessi e lo storage montato; non vede chiavi, vault, database o le cartelle delle altre istanze.",
      "- **Rete**: aperta, **solo i domini in elenco** (passando da un proxy) oppure nessuna.",
      "- **Limiti**: memoria, CPU e tempo massimo per comando.",
      "",
      "Si imposta a cascata: **istanza → agente → missione → task**. Istanza e agente li decidi tu (Impostazioni → Sandbox, scheda Sandbox dell'agente); missioni e task possono solo **restringere**. Una richiesta più larga viene ignorata e compare in **Events**.",
      "",
      "La sandbox è **opzionale**: di base i comandi girano sulla macchina come prima. Con l'interruttore **Isola gli agenti che leggono contenuti esterni** (Impostazioni → Sandbox), Polpo e gli agenti con strumenti web, email o messaggi girano almeno in bubblewrap, salvo eccezioni che decidi tu agente per agente.",
      "",
      "- **Rete aperta** ora passa da un proxy: internet sì, ma mai i servizi di questa macchina o le reti private. **Senza limiti** è l'opzione esplicita per chi ne ha davvero bisogno. Con la lista di domini funzionano anche git via ssh e le connessioni non HTTP.",
      "- I domini **rifiutati** compaiono in Events e in Impostazioni → Sandbox, con un clic per consentirli a un agente o a tutti.",
      "- **Sandbox remote**: collega **Daytona** o **E2B** in Impostazioni → Sandbox (chiave, test di connessione). I task possono girare in una VM remota: la cartella di lavoro ci viene copiata (senza node_modules, .polpo e i file esclusi da .gitignore, quindi i segreti nei .env restano qui) e i file modificati tornano alla fine.",
    ].join("\n"),
  },
  {
    id: "2026-10-06-storage",
    date: "2026-10-06",
    kind: "new",
    title: "Storage: bucket S3 e R2 come cartelle per gli agenti",
    summary: "Collega un bucket (Cloudflare R2, AWS S3, MinIO…): viene montato sul server e gli agenti lo vedono come una cartella.",
    body: [
      "Nella nuova pagina **Storage** puoi collegare un bucket **S3 compatibile**: Cloudflare R2, AWS S3, MinIO, Backblaze B2, Wasabi e altri.",
      "",
      "- Il bucket viene **montato sul server** e compare come cartella anche nella pagina **Files**.",
      "- Scegli **quali agenti** lo vedono, in **sola lettura** o anche in **scrittura**, ed eventualmente solo una sottocartella (prefisso).",
      "- Gli agenti con gli strumenti `storage_*` possono elencare, leggere, scrivere e cancellare file, e creare **link di download temporanei**.",
      "- Le **chiavi** stanno cifrate nel Vault: non vengono mai mostrate di nuovo né date agli agenti.",
      "",
      "Per le sandbox remote puoi aggiungere una **chiave dedicata e limitata**, separata da quella principale.",
    ].join("\n"),
    cta: { label: "Apri Storage", to: "/storage" },
  },
  {
    id: "2026-10-06-agent-to-agent",
    date: "2026-10-06",
    kind: "new",
    highlight: true,
    title: "Gli agenti si parlano tra loro",
    summary: "Un agente può chiedere a un altro con @nome e quello risponde, sul web e nei gruppi Telegram.",
    body: [
      "Un agente può rivolgersi a un collega scrivendo **@nome**: l'altro agente risponde nella stessa conversazione, sia nei gruppi sul web sia nei **gruppi Telegram**.",
      "",
      "Ci sono dei freni per evitare discussioni infinite:",
      "",
      "- al massimo **3 passaggi** tra agenti dopo ogni tuo messaggio (si può cambiare nelle impostazioni del gruppo);",
      "- **un tuo messaggio ferma la catena** e si riparte da quello che hai scritto.",
    ].join("\n"),
  },
  {
    id: "2026-10-06-ink-hub",
    date: "2026-10-06",
    kind: "new",
    title: "Polpo Ink Hub è di nuovo attivo",
    summary: "Il catalogo dei template (agenti, playbook, company) ora gira sul nostro server.",
    body: [
      "Il catalogo **Polpo Ink Hub** è tornato: lo trovi dal link nel menu laterale.",
      "",
      "- Elenca tutti i template del nostro registry privato: **agenti**, **playbook** e **company** (configurazioni complete con team e skill).",
      "- Gli agenti e Polpo possono cercarli e installarli con gli strumenti Ink, e nuovi template compaiono da soli quando vengono aggiunti al registry.",
      "- Per ora è raggiungibile solo dalla rete interna (Tailscale).",
    ].join("\n"),
  },
  {
    id: "2026-10-05-models-pi-1-0-4",
    date: "2026-10-05",
    kind: "improved",
    title: "Nuovi modelli",
    summary: "Aggiornato il motore dei modelli: disponibili Claude Opus 5.5 e GPT-6 Sol tra gli altri.",
    body: [
      "Abbiamo aggiornato il motore dei modelli (**pi 1.0.4**).",
      "",
      "Tra le novità sono disponibili **Claude Opus 5.5** e **GPT-6 Sol**: li trovi nella scelta del modello di ogni agente.",
    ].join("\n"),
  },
];

export const CHANGELOG_KIND_LABEL: Record<ChangelogKind, string> = {
  new: "Nuovo",
  improved: "Migliorato",
  fixed: "Corretto",
};

/** Entries the person has not seen yet, newest first. */
export function unseenEntries(entries: ChangelogEntry[], seen: ReadonlySet<string>): ChangelogEntry[] {
  return entries.filter((entry) => !seen.has(entry.id));
}

/** Highlighted entries the person has not seen yet, newest first. */
export function unseenHighlights(entries: ChangelogEntry[], seen: ReadonlySet<string>): ChangelogEntry[] {
  return entries.filter((entry) => entry.highlight && !seen.has(entry.id));
}

/** "2026-10-06" → a local Date (no timezone shift). */
export function changelogDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : new Date(iso);
}

const DATE_FORMAT = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "long", year: "numeric" });

/** "6 ottobre 2026" */
export function formatChangelogDate(iso: string): string {
  const date = changelogDate(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE_FORMAT.format(date);
}

/** Entries grouped by date, newest date first (keeps the order inside a day). */
export function groupChangelogByDate(entries: ChangelogEntry[]): { date: string; entries: ChangelogEntry[] }[] {
  const groups: { date: string; entries: ChangelogEntry[] }[] = [];
  for (const entry of [...entries].sort((a, b) => b.date.localeCompare(a.date))) {
    const last = groups.at(-1);
    if (last?.date === entry.date) last.entries.push(entry);
    else groups.push({ date: entry.date, entries: [entry] });
  }
  return groups;
}
