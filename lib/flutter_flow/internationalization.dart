import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _kLocaleStorageKey = '__locale_key__';

class FFLocalizations {
  FFLocalizations(this.locale);

  final Locale locale;

  static FFLocalizations of(BuildContext context) =>
      Localizations.of<FFLocalizations>(context, FFLocalizations)!;

  static List<String> languages() => ['it', 'en', 'es'];

  static late SharedPreferences _prefs;
  static Future initialize() async =>
      _prefs = await SharedPreferences.getInstance();
  static Future storeLocale(String locale) =>
      _prefs.setString(_kLocaleStorageKey, locale);
  static Locale? getStoredLocale() {
    final locale = _prefs.getString(_kLocaleStorageKey);
    return locale != null && locale.isNotEmpty ? createLocale(locale) : null;
  }

  String get languageCode => locale.toString();
  String? get languageShortCode =>
      _languagesWithShortCode.contains(locale.toString())
          ? '${locale.toString()}_short'
          : null;
  int get languageIndex => languages().contains(languageCode)
      ? languages().indexOf(languageCode)
      : 0;

  String getText(String key) =>
      (kTranslationsMap[key] ?? {})[locale.toString()] ?? '';

  String getVariableText({
    String? itText = '',
    String? enText = '',
    String? esText = '',
  }) =>
      [itText, enText, esText][languageIndex] ?? '';

  static const Set<String> _languagesWithShortCode = {
    'ar',
    'az',
    'ca',
    'cs',
    'da',
    'de',
    'dv',
    'en',
    'es',
    'et',
    'fi',
    'fr',
    'gr',
    'he',
    'hi',
    'hu',
    'it',
    'km',
    'ku',
    'mn',
    'ms',
    'no',
    'pt',
    'ro',
    'ru',
    'rw',
    'sv',
    'th',
    'uk',
    'vi',
  };
}

/// Used if the locale is not supported by GlobalMaterialLocalizations.
class FallbackMaterialLocalizationDelegate
    extends LocalizationsDelegate<MaterialLocalizations> {
  const FallbackMaterialLocalizationDelegate();

  @override
  bool isSupported(Locale locale) => _isSupportedLocale(locale);

  @override
  Future<MaterialLocalizations> load(Locale locale) async =>
      SynchronousFuture<MaterialLocalizations>(
        const DefaultMaterialLocalizations(),
      );

  @override
  bool shouldReload(FallbackMaterialLocalizationDelegate old) => false;
}

/// Used if the locale is not supported by GlobalCupertinoLocalizations.
class FallbackCupertinoLocalizationDelegate
    extends LocalizationsDelegate<CupertinoLocalizations> {
  const FallbackCupertinoLocalizationDelegate();

  @override
  bool isSupported(Locale locale) => _isSupportedLocale(locale);

  @override
  Future<CupertinoLocalizations> load(Locale locale) =>
      SynchronousFuture<CupertinoLocalizations>(
        const DefaultCupertinoLocalizations(),
      );

  @override
  bool shouldReload(FallbackCupertinoLocalizationDelegate old) => false;
}

class FFLocalizationsDelegate extends LocalizationsDelegate<FFLocalizations> {
  const FFLocalizationsDelegate();

  @override
  bool isSupported(Locale locale) => _isSupportedLocale(locale);

  @override
  Future<FFLocalizations> load(Locale locale) =>
      SynchronousFuture<FFLocalizations>(FFLocalizations(locale));

  @override
  bool shouldReload(FFLocalizationsDelegate old) => false;
}

Locale createLocale(String language) => language.contains('_')
    ? Locale.fromSubtags(
        languageCode: language.split('_').first,
        scriptCode: language.split('_').last,
      )
    : Locale(language);

bool _isSupportedLocale(Locale locale) {
  final language = locale.toString();
  return FFLocalizations.languages().contains(
    language.endsWith('_')
        ? language.substring(0, language.length - 1)
        : language,
  );
}

final kTranslationsMap = <Map<String, Map<String, String>>>[
  // Home
  {
    'mc3ul20l': {
      'it': 'Ciao,',
      'en': 'Hi,',
      'es': 'Hola,',
    },
    'jdiqvkzv': {
      'it': 'Bentornato in BF Wellness',
      'en': 'Welcome back to BF Wellness',
      'es': 'Bienvenido de nuevo a BF Wellness',
    },
    'evd86txk': {
      'it': 'Dashboard',
      'en': 'Dashboards',
      'es': 'Paneles de control',
    },
    '1ker0x7y': {
      'it': 'Situazione pagamenti',
      'en': 'Payment situation',
      'es': 'situación de pago',
    },
    'h10w99z1': {
      'it': 'I tuoi appuntamenti',
      'en': 'Your appointments',
      'es': 'Tus citas',
    },
    '71qkkcep': {
      'it': 'In arrivo',
      'en': 'Upcoming',
      'es': 'Llegando',
    },
    'q0oez6ge': {
      'it': 'Vedi tutti',
      'en': '',
      'es': '',
    },
    'ly3jur9a': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Account
  {
    'ld7t2eqn': {
      'it': 'Le tua struttura',
      'en': 'Your structure',
      'es': 'Tu estructura',
    },
    '5otp6ou7': {
      'it': 'Formazione',
      'en': 'Training',
      'es': 'Capacitación',
    },
    'udgk5rg6': {
      'it': 'Video formativi BF',
      'en': 'BF training videos',
      'es': 'Vídeos de entrenamiento de BF',
    },
    'rzl8zdw2': {
      'it': 'About',
      'en': 'About',
      'es': 'About',
    },
    's3jwcs5n': {
      'it': 'Privacy Policy, Termini e condizioni',
      'en': 'Privacy Policy, Terms and Conditions',
      'es': 'Política de privacidad, términos y condiciones',
    },
    'spsdtmxw': {
      'it': 'Lingua',
      'en': 'Language',
      'es': 'Idioma',
    },
    'bj1q44mb': {
      'it': 'Logout',
      'en': 'Logout',
      'es': 'Cerrar sesión',
    },
    '4clfuv7w': {
      'it': '',
      'en': 'Reorder your favorite service in a click',
      'es': '',
    },
    'e434d7ls': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Router
  {
    'w7qqc6og': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Onboarding
  {
    'lvjozsyf': {
      'it': 'Organizza e gestisci i tuoi appuntamenti con facilità.',
      'en': 'Organize and manage your appointments with ease.',
      'es': 'Organiza y gestiona tus citas con facilidad.',
    },
    'cqzarh0z': {
      'it':
          ' Visualizza l\'agenda condivisa, prenota nuove sessioni e modifica gli appuntamenti esistenti.',
      'en':
          'View the shared agenda, book new sessions and edit existing appointments.',
      'es':
          'Vea la agenda compartida, reserve nuevas sesiones y edite citas existentes.',
    },
    'bhxr1nny': {
      'it': 'Gestione semplice ed intuitiva\n dei clienti.',
      'en': 'Simple and intuitive management\n of customers.',
      'es': 'Gestión sencilla e intuitiva\n de clientes.',
    },
    'h5q1sl9k': {
      'it':
          'Registra nuovi clienti, accedi rapidamente alla loro cronologia di prenotazioni.',
      'en': 'Register new customers, quickly access their booking history.',
      'es':
          'Registre nuevos clientes, acceda rápidamente a su historial de reservas.',
    },
    'l40y200y': {
      'it': 'Gestione e Incasso dei Pagamenti',
      'en': 'Management and Collection of Payments',
      'es': 'Gestión y Cobro de Pagos',
    },
    '35mqausp': {
      'it':
          'Mantieni il controllo dei tuoi incassi. Tieni traccia dei pagamenti  per ogni cliente.',
      'en':
          'Maintain control of your takings. Track payments for each customer.',
      'es':
          'Mantenga el control de sus ingresos. Realice un seguimiento de los pagos de cada cliente.',
    },
    'fzul6l0v': {
      'it': 'Salta',
      'en': 'Skip',
      'es': 'Saltar',
    },
    'hbh5il2h': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Accomodations
  {
    '2dqd3eeb': {
      'it': 'Le tue strutture',
      'en': 'Your facilities',
      'es': 'Tus instalaciones',
    },
    'h1n788jo': {
      'it': 'Seleziona la struttura in cui stai lavorando',
      'en': '',
      'es': '',
    },
    'r9n246e1': {
      'it': 'Continua',
      'en': 'Continue',
      'es': 'continúa',
    },
    'pj20lka5': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // About
  {
    'ezunt40b': {
      'it': 'About',
      'en': 'About',
      'es': 'Acerca de',
    },
    'bv6eb191': {
      'it': 'Termini e condizioni',
      'en': 'Terms and conditions',
      'es': 'Términos y condiciones',
    },
    'jqnornnp': {
      'it': '',
      'en': '',
      'es': '',
    },
    'hgfl530l': {
      'it': 'Privacy Policy',
      'en': 'Privacy Policy',
      'es': 'política de privacidad',
    },
    'pjg8ubqj': {
      'it': '',
      'en': '',
      'es': '',
    },
    '7h7271gh': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // TOS
  {
    't3wl9yga': {
      'it': 'Termini e condizioni',
      'en': 'Terms and conditions',
      'es': 'Términos y condiciones',
    },
    'u94z5fx9': {
      'it':
          '1. Accettazione dei Termini\nUtilizzando l\'app BF Wellness, l\'utente accetta di essere vincolato ai seguenti termini e condizioni. Se non si accettano questi termini, non si deve utilizzare l\'app.\n\n2. Modifiche ai Termini\nBF Wellness si riserva il diritto di modificare o rivedere questi termini in qualsiasi momento. L\'uso continuato dell\'app dopo tali modifiche costituirà accettazione dei nuovi termini.\n\n3. Utilizzo dell\'App\nL\'app BF Wellness è fornita per la gestione degli appuntamenti, la vendita di prodotti e servizi, e la gestione dei pagamenti. L\'utente accetta di utilizzare l\'app solo per scopi legali e in conformità con le leggi applicabili.\n\n4. Account e Sicurezza\nL\'utente è responsabile della sicurezza e della riservatezza del proprio account e password. BF Wellness non è responsabile per qualsiasi perdita derivante dall\'accesso non autorizzato al proprio account.\n\n5. Proprietà Intellettuale\nTutto il contenuto dell\'app, inclusi testi, grafica, logo, icone, immagini, è di proprietà di BF Wellness o dei suoi fornitori e protetto dalle leggi sulla proprietà intellettuale.\n\n6. Limitazione di Responsabilità\nBF Wellness non sarà responsabile per danni diretti, indiretti, incidentali, speciali o consequenziali derivanti dall\'uso o dall\'impossibilità di usare l\'app.\n\n7. Privacy\nLa privacy degli utenti è importante per noi. Fare riferimento all\'Informativa sulla Privacy per capire come raccogliamo e trattiamo i dati personali.\n\n8. Interruzione e Sospensione\nBF Wellness si riserva il diritto di interrompere o sospendere l\'accesso all\'app senza preavviso per manutenzione, aggiornamenti, o per altre ragioni.\n\n9. Legge Applicabile\nQuesti termini sono regolati dalle leggi del paese in cui BF Wellness è registrata. Qualsiasi controversia sarà sottoposta alla giurisdizione esclusiva dei tribunali di quel paese.\n\n10. Contatti\nPer qualsiasi domanda relativa a questi termini, si prega di contattare BF Wellness tramite',
      'en':
          '1. Acceptance of the Terms\nBy using the BF Wellness app, you agree to be bound by the following terms and conditions. If you do not agree to these terms, you should not use the app.\n\n2. Changes to the Terms\nBF Wellness reserves the right to modify or revise these terms at any time. Your continued use of the App after such changes will constitute your acceptance of the new terms.\n\n3. Use of the App\nThe BF Wellness app is provided for managing appointments, selling products and services, and managing payments. You agree to use the App only for lawful purposes and in accordance with applicable laws.\n\n4. Account and Security\nYou are responsible for maintaining the security and confidentiality of your account and password. BF Wellness is not responsible for any losses resulting from unauthorized access to your account.\n\n5. Intellectual Property\nAll content in the app, including text, graphics, logos, icons, images, is the property of BF Wellness or its suppliers and protected by intellectual property laws.\n\n6. Limitation of Liability\nBF Wellness will not be liable for any direct, indirect, incidental, special or consequential damages arising out of the use or inability to use the app.\n\n7. Privacy\nUser privacy is important to us. Please refer to the Privacy Policy to understand how we collect and process personal data.\n\n8. Interruption and Suspension\nBF Wellness reserves the right to interrupt or suspend access to the app without notice for maintenance, updates, or other reasons.\n\n9. Applicable Law\nThese terms are governed by the laws of the country in which BF Wellness is registered. Any disputes will be subject to the exclusive jurisdiction of the courts of that country.\n\n10. Contacts\nIf you have any questions regarding these terms, please contact BF Wellness via',
      'es':
          '1. Aceptación de los Términos\nAl utilizar la aplicación BF Wellness, usted acepta estar sujeto a los siguientes términos y condiciones. Si no está de acuerdo con estos términos, no debe utilizar la aplicación.\n\n2. Cambios a los Términos\nBF Wellness se reserva el derecho de modificar o revisar estos términos en cualquier momento. Su uso continuado de la Aplicación después de dichos cambios constituirá su aceptación de los nuevos términos.\n\n3. Uso de la aplicación\nLa aplicación BF Wellness se proporciona para gestionar citas, vender productos y servicios y gestionar pagos. Acepta utilizar la Aplicación únicamente para fines legales y de conformidad con las leyes aplicables.\n\n4. Cuenta y seguridad\nUsted es responsable de mantener la seguridad y confidencialidad de su cuenta y contraseña. BF Wellness no es responsable de ninguna pérdida resultante del acceso no autorizado a su cuenta.\n\n5. Propiedad intelectual\nTodo el contenido de la aplicación, incluidos textos, gráficos, logotipos, íconos e imágenes, es propiedad de BF Wellness o sus proveedores y está protegido por las leyes de propiedad intelectual.\n\n6. Limitación de responsabilidad\nBF Wellness no será responsable de ningún daño directo, indirecto, incidental, especial o consecuente que surja del uso o la imposibilidad de usar la aplicación.\n\n7. Privacidad\nLa privacidad del usuario es importante para nosotros. Consulte la Política de privacidad para comprender cómo recopilamos y procesamos datos personales.\n\n8. Interrupción y Suspensión\nBF Wellness se reserva el derecho de interrumpir o suspender el acceso a la aplicación sin previo aviso por motivos de mantenimiento, actualizaciones u otros motivos.\n\n9. Ley Aplicable\nEstos términos se rigen por las leyes del país en el que BF Wellness está registrado. Cualquier disputa estará sujeta a la jurisdicción exclusiva de los tribunales de ese país.\n\n10. Contactos\nSi tiene alguna pregunta sobre estos términos, comuníquese con BF Wellness a través de',
    },
    '4rs74r00': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // PrivacyPolicy
  {
    'jjdgbwy8': {
      'it': 'Privacy Policy',
      'en': 'Privacy Policy',
      'es': 'política de privacidad',
    },
    'h35hd5fu': {
      'it':
          'Lo scopo del presente documento è di informare la persona fisica (di seguito “Interessato”) relativamente al trattamento dei suoi dati personali (di seguito “Dati Personali”) raccolti dal titolare del trattamento, BF Wellness Società a Responsabilità Limitata Semplificata, Via XX Settembre 52, 00042 – Anzio (RM), Codice Fiscale e Partita IVA 13839101006, indirizzo e-mail info@bfwellness.it, (di seguito “Titolare”), tramite il sito web www.bfwellness.it (di seguito “Applicazione”).\n\nLe modifiche e gli aggiornamenti saranno vincolanti non appena pubblicati sull’Applicazione. In caso di mancata accettazione delle modifiche apportate all’Informativa Privacy, l’Interessato è tenuto a cessare l’utilizzo di questa Applicazione e può richiedere al Titolare di cancellare i propri Dati Personali.\n\nCategorie Di Dati Personali Trattati\nIl Titolare tratta le seguenti tipologie di Dati Personali forniti volontariamente dall’Interessato:\n\nDati di contatto: nome, cognome, indirizzo, e-mail, telefono, immagini, credenziali di autenticazione, eventuali ulteriori informazioni inviate dall’Interessato, etc.\nIl Titolare tratta le seguenti tipologie di Dati Personali raccolti in maniera automatizzata:\n\nDati tecnici: Dati Personali prodotti dai dispositivi, dalle applicazioni, dagli strumenti e dai protocolli utilizzati, quali ad esempio, informazioni sul dispositivo utilizzato, indirizzi IP, tipo di browser, tipo di provider Internet (ISP). Tali Dati Personali possono lasciare tracce che, in particolare se combinate con identificativi univoci e altre informazioni ricevute dai server, possono essere utilizzate per creare profili delle persone fisiche\nDati di navigazione e di utilizzo dell’Applicazione: quali, ad esempio, pagine visitate, numero di clic, azioni compiute, durata delle sessioni, etc.\nIl mancato conferimento da parte dell’Interessato dei Dati Personali per i quali sussiste l’obbligo legale, contrattuale o qualora costituiscano requisito necessario per la conclusione del contratto con il Titolare, comporterà l’impossibilità del Titolare di instaurare o proseguire il rapporto con l’Interessato.\n\nL’Interessato che comunichi al Titolare Dati Personali di terzi è direttamente ed esclusivamente responsabile della loro provenienza, raccolta, trattamento, comunicazione o diffusione.\n\nCookie E Tecnologie Simili\nL’Applicazione usa cookie, web beacon, identificatori univoci e altre analoghe tecnologie per raccogliere Dati Personali dell’Interessato sulle pagine, sui collegamenti visitati e sulle altre azioni che si eseguono quando l’Interessato utilizza l’Applicazione. Essi vengono memorizzati per essere poi trasmessi alla successiva visita dell’Interessato. Si può prendere visione della Cookie Policy completa al seguente indirizzo: https://www.bfwellness.it/cookie-policy\n\nBase Giuridica E Finalità Del Trattamento\nIl trattamento dei Dati Personali è necessario:\n\nper l’esecuzione del contratto con l’Interessato e precisamente:\nadempimento di ogni obbligo derivante dal rapporto precontrattuale o contrattuale con l’Interessato\nper obbligo di legge e precisamente:\nl’adempimento di qualunque obbligo previsto dalle vigenti normative, leggi e regolamenti, in particolare, in materia tributaria e fiscale\nsulla base del legittimo interesse del Titolare, per:\nfinalità di marketing via email di prodotti e/o servizi del titolare per vendere direttamente i prodotti o servizi del Titolare utilizzando l’e-mail fornita dall’Interessato nel contesto della vendita di un prodotto o servizio analogo a quello oggetto della vendita\nsulla base del consenso dell’Interessato, per:\nprofilazione dell’Interessato per fini di marketing: per fornire all’Interessato informazioni sui prodotti e/o servizi del Titolare attraverso un trattamento automatizzato finalizzato alla raccolta di informazioni personali con lo scopo di prevedere o valutare le sue preferenze o comportamenti\nretargeting e remarketing: per raggiungere con un annuncio pubblicitario personalizzato l’Interessato che ha già visitato o ha dimostrato interesse per i prodotti e/o servizi offerti dall’Applicazione utilizzando i suoi Dati Personali. L’Interessato può effettuare l’opt-out visitando la pagina della Network Advertising Initiative\nfinalità di marketing di prodotti e/o servizi del Titolare: per inviare informazioni o materiali commerciali e/o promozionali, per effettuare attività di vendita diretta di prodotti e/o servizi del Titolare o per compiere ricerche di mercato con modalità automatizzate e tradizionali\nfinalità di marketing di prodotti e/o servizi di terzi: per inviare informazioni o materiali commerciali e/o promozionali di terzi, per effettuare attività di vendita diretta o per compiere ricerche di mercato dei loro prodotti e/o servizi con modalità automatizzate e tradizionali\nI Dati Personali dell’Interessato possono inoltre essere utilizzati dal Titolare per tutelarsi in giudizio avanti le sedi giudiziarie competenti.\n\nModalità Di Trattamento E Destinatari Dei Dati Personali\nIl trattamento dei Dati Personali viene effettuato mediante strumenti cartacei e informatici con modalità organizzative e con logiche strettamente correlate alle finalità indicate e mediante l’adozione di adeguate misure di sicurezza.\n\nI Dati Personali sono trattati esclusivamente da:\n\npersone autorizzate dal Titolare del trattamento dei Dati Personali che si sono impegnate alla riservatezza o abbiano un adeguato obbligo legale di riservatezza;\nsoggetti che operano in autonomia come distinti titolari del trattamento o da soggetti designati quali responsabili del trattamento dal Titolare al fine di svolgere tutte le attività di trattamento necessarie a perseguire le finalità di cui alla presente informativa (ad esempio, partner commerciali, consulenti, società informatiche, fornitori di servizi, hosting provider);\nsoggetti o enti a cui è obbligatorio comunicare i Dati Personali per obbligo di legge o per ordine delle autorità.\nI soggetti sopra elencati sono tenuti a utilizzare le garanzie appropriate per proteggere i Dati Personali e possono accedere solo a quelli necessari per eseguire i compiti a loro assegnati.\n\nI Dati Personali non verranno diffusi indiscriminatamente in alcun modo.\n\nLuogo\nI Dati Personali non saranno oggetto di alcun trasferimento al di fuori del territorio dello Spazio Economico Europeo (SEE).\n\nPeriodo Di Conservazione Dei Dati Personali\nI Dati Personali saranno conservati per il periodo di tempo necessario ad adempiere alle finalità per i quali sono stati raccolti, in particolare:\n\nper finalità relative all’esecuzione del contratto tra il Titolare e l’Interessato, saranno conservati per tutta la durata del rapporto contrattuale e, dopo la cessazione, per il periodo di prescrizione ordinario pari a 10 anni. Nel caso di contenzioso giudiziale, per tutta la durata dello stesso, fino all’esaurimento dei termini di esperibilità delle azioni di impugnazione\nper finalità relative al legittimo interesse del Titolare, saranno conservati fino al compimento di tale interesse\nper l’adempimento di un obbligo di legge, per ordine di un’autorità e per la tutela in giudizio, saranno conservati nel rispetto delle tempistiche previste da detti obblighi, normative e comunque sino al compimento del termine prescrizionale previsto dalle norme in vigore\nper finalità basate sul consenso dell’Interessato, saranno conservati sino alla revoca del consenso\nAl termine del periodo di conservazione, tutti i Dati Personali saranno cancellati o conservati in una forma che non consenta l’identificazione dell’Interessato.\n\nDiritti Dell’Interessato\nGli Interessati possono esercitare determinati diritti con riferimento ai Dati Personali trattati dal Titolare. In particolare, l’Interessato ha il diritto di:\n\nessere informato sul trattamento dei propri Dati Personali\nrevocare il consenso in ogni momento\nlimitare il trattamento dei propri Dati Personali\nopporsi al trattamento dei propri Dati Personali\naccedere ai propri Dati Personali\nverificare e chiedere la rettifica dei propri Dati Personali\nottenere la limitazione del trattamento dei propri Dati Personali\nottenere la cancellazione dei propri Dati Personali\ntrasferire i propri Dati Personali ad altro titolare\nproporre reclamo all’autorità di controllo della protezione dei propri Dati Personali e/o agire in sede giudiziale.\nPer esercitare i propri diritti, gli Interessati possono indirizzare una richiesta al seguente indirizzo e-mail info@bfwellness.it. Le richieste saranno prese in carico dal Titolare immediatamente ed evase nel più breve tempo possibile, in ogni caso entro 30 giorni.',
      'en':
          'The purpose of this document is to inform the natural person (hereinafter \"Interested Party\") regarding the processing of his personal data (hereinafter \"Personal Data\") collected by the data controller, BF Wellness Società a Responsabilità Limitata Simplificata, Via XX Settembre 52, 00042 – Anzio (RM), Tax Code and VAT number 13839101006, e-mail address info@bfwellness.it, (hereinafter “Owner”), via the website www.bfwellness.it (hereinafter “Application”) .\n\nChanges and updates will be binding as soon as they are published on the Application. In case of non-acceptance of the changes made to the Privacy Policy, the interested party is required to cease using this Application and may request the Owner to delete their Personal Data.\n\nCategories of Personal Data Processed\nThe Data Controller processes the following types of Personal Data provided voluntarily by the Interested Party:\n\nContact data: name, surname, address, e-mail, telephone, images, authentication credentials, any further information sent by the interested party, etc.\nThe Data Controller processes the following types of Personal Data collected automatically:\n\nTechnical data: Personal data produced by the devices, applications, tools and protocols used, such as, for example, information on the device used, IP addresses, browser type, type of Internet provider (ISP). Such Personal Data may leave traces which, in particular when combined with unique identifiers and other information received from servers, can be used to create profiles of natural persons\nNavigation and use data of the Application: such as, for example, pages visited, number of clicks, actions performed, duration of sessions, etc.\nFailure by the interested party to provide the Personal Data for which there is a legal or contractual obligation or if they constitute a necessary requirement for the conclusion of the contract with the Data Controller, will make it impossible for the Data Controller to establish or continue the relationship with the Data Controller. Interested.\n\nThe interested party who communicates the Personal Data of third parties to the Data Controller is directly and exclusively responsible for their origin, collection, processing, communication or dissemination.\n\nCookies And Similar Technologies\nThe Application uses cookies, web beacons, unique identifiers and other similar technologies to collect Personal Data of the Interested Party on the pages, links visited and other actions performed when the Interested Party uses the Application. They are stored before being transmitted on the next visit by the interested party. You can view the complete Cookie Policy at the following address: https://www.bfwellness.it/cookie-policy\n\nLegal basis and purpose of the processing\nThe processing of Personal Data is necessary:\n\nfor the execution of the contract with the interested party and precisely:\nfulfillment of any obligation deriving from the pre-contractual or contractual relationship with the interested party\nby legal obligation and precisely:\nthe fulfillment of any obligation provided for by current regulations, laws and regulations, in particular, in tax and fiscal matters\non the basis of the legitimate interest of the Data Controller, for:\nmarketing purposes via email of the owner\'s products and/or services to directly sell the owner\'s products or services using the email provided by the interested party in the context of the sale of a product or service similar to the one being sold\non the basis of the consent of the interested party, for:\nprofiling of the interested party for marketing purposes: to provide the interested party with information on the Data Controller\'s products and/or services through automated processing aimed at collecting personal information with the aim of predicting or evaluating their preferences or behaviors\nretargeting and remarketing: to reach the interested party who has already visited or shown interest in the products and/or services offered by the Application using their Personal Data with a personalized advertisement. The interested party can opt-out by visiting the Network Advertising Initiative page\nmarketing purposes of the Owner\'s products and/or services: to send information or commercial and/or promotional materials, to carry out direct sales activities of the Owner\'s products and/or services or to carry out market research using automated and traditional methods\nmarketing purposes of third party products and/or services: to send information or commercial and/or promotional materials of third parties, to carry out direct sales activities or to carry out market research of their products and/or services with automated and traditional methods\nThe Personal Data of the interested party may also be used by the Data Controller to protect himself in court before the competent judicial offices.\n\nMethods of Processing and Recipients of Personal Data\nThe processing of Personal Data is carried out using paper and IT tools with organizational methods and logic strictly related to the purposes indicated and through the adoption of adequate security measures.\n\nPersonal Data is processed exclusively by:\n\npersons authorized by the Data Controller of Personal Data who are committed to confidentiality or have an adequate legal obligation of confidentiality;\nsubjects who operate independently as separate data controllers or by subjects designated as data controllers by the Data Controller in order to carry out all the processing activities necessary to pursue the purposes referred to in this information (for example, commercial partners, consultants, IT companies , service providers, hosting providers);\nsubjects or bodies to whom it is mandatory to communicate Personal Data by legal obligation or by order of the authorities.\nThe subjects listed above are required to use appropriate safeguards to protect Personal Data and may only access those necessary to perform the tasks assigned to them.\n\nPersonal Data will not be disclosed indiscriminately in any way.\n\nPlace\nPersonal Data will not be subject to any transfer outside the territory of the European Economic Area (EEA).\n\nPersonal Data Retention Period\nPersonal Data will be retained for the period of time necessary to fulfill the purposes for which they were collected, in particular:\n\nfor purposes relating to the execution of the contract between the Owner and the Interested Party, will be kept for the entire duration of the contractual relationship and, after termination, for the ordinary limitation period of 10 years. In the case of judicial litigation, for the entire duration of the same, until the deadlines for appeals have been exhausted\nfor purposes relating to the legitimate interest of the Data Controller, will be retained until such interest is fulfilled\nfor the fulfillment of a legal obligation, by order of an authority and for protection in court, they will be kept in compliance with the deadlines established by said obligations, regulations and in any case until the expiry of the limitation period established by the regulations in force\nfor purposes based on the consent of the interested party, they will be kept until the consent is revoked\nAt the end of the retention period, all Personal Data will be deleted or stored in a form that does not allow the identification of the interested party.\n\nRights of the interested party\nInterested parties can exercise certain rights with reference to the Personal Data processed by the Owner. In particular, the interested party has the right to:\n\nbe informed about the processing of your Personal Data\nrevoke your consent at any time\nlimit the processing of your Personal Data\nobject to the processing of your Personal Data\naccess your Personal Data\nverify and request rectification of your Personal Data\nobtain the limitation of the processing of your Personal Data\nobtain the deletion of their Personal Data\ntransfer your Personal Data to another owner\nlodge a complaint with the supervisory authority for the protection of your Personal Data and/or take legal action.\nTo exercise their rights, interested parties can send a request to the following e-mail address info@bfwellness.it. Requests will be taken care of by the Data Controller immediately and processed as quickly as possible, in any case within 30 days.',
      'es':
          'El presente documento tiene como finalidad informar a la persona física (en adelante \"Interesado\") sobre el tratamiento de sus datos personales (en adelante \"Datos Personales\") recopilados por el responsable del tratamiento, BF Wellness Società a Responsabilità Limitata Simplificata, Via XX Settembre 52. , 00042 – Anzio (RM), CIF y número de IVA 13839101006, dirección de correo electrónico info@bfwellness.it, (en adelante “Propietario”), a través del sitio web www.bfwellness.it (en adelante “Solicitud”).\n\nLos cambios y actualizaciones serán vinculantes tan pronto como se publiquen en la Aplicación. En caso de no aceptación de los cambios realizados a la Política de Privacidad, el interesado se obliga a dejar de utilizar esta Aplicación y podrá solicitar al Titular la eliminación de sus Datos Personales.\n\nCategorías de datos personales procesados\nEl Responsable del tratamiento trata los siguientes tipos de Datos Personales proporcionados voluntariamente por el Interesado:\n\nDatos de contacto: nombre, apellidos, dirección, correo electrónico, teléfono, imágenes, credenciales de autenticación, cualquier otra información enviada por el interesado, etc.\nEl Responsable del tratamiento procesa los siguientes tipos de Datos personales recopilados automáticamente:\n\nDatos técnicos: Datos personales producidos por los dispositivos, aplicaciones, herramientas y protocolos utilizados, como, por ejemplo, información sobre el dispositivo utilizado, direcciones IP, tipo de navegador, tipo de proveedor de Internet (ISP). Dichos Datos personales pueden dejar rastros que, en particular cuando se combinan con identificadores únicos y otra información recibida de los servidores, pueden usarse para crear perfiles de personas físicas.\nDatos de navegación y uso de la Aplicación: como, por ejemplo, páginas visitadas, número de clics, acciones realizadas, duración de las sesiones, etc.\nLa falta de facilitación por parte del interesado de los Datos Personales respecto de los cuales existe una obligación legal o contractual o si constituyen un requisito necesario para la celebración del contrato con el Responsable, imposibilitará que el Responsable establezca o continúe la relación con el Responsable del tratamiento.Interesado.\n\nEl interesado que comunica Datos Personales de terceros al Responsable del tratamiento es responsable directo y exclusivo de su origen, recogida, tratamiento, comunicación o difusión.\n\nCookies y tecnologías similares\nLa Aplicación utiliza cookies, web beacons, identificadores únicos y otras tecnologías similares para recopilar Datos Personales del Interesado en las páginas, enlaces visitados y otras acciones realizadas cuando el Interesado utiliza la Aplicación. Se almacenan antes de ser transmitidos en la siguiente visita del interesado. Puede consultar la Política de Cookies completa en la siguiente dirección: https://www.bfwellness.it/cookie-policy\n\nBase jurídica y finalidad del tratamiento\nEl tratamiento de Datos Personales es necesario:\n\npara la ejecución del contrato con el interesado y precisamente:\ncumplimiento de cualquier obligación derivada de la relación precontractual o contractual con el interesado\npor obligación legal y precisamente:\nel cumplimiento de cualquier obligación prevista por las normas, leyes y reglamentos vigentes, en particular, en materia tributaria y fiscal\nsobre la base del interés legítimo del Responsable del tratamiento, para:\nfines de marketing vía correo electrónico de los productos y/o servicios del titular para vender directamente los productos o servicios del titular utilizando el correo electrónico proporcionado por el interesado en el contexto de la venta de un producto o servicio similar al que se vende\nsobre la base del consentimiento del interesado, para:\nelaboración de perfiles del interesado con fines de marketing: proporcionar al interesado información sobre los productos y/o servicios del Responsable del tratamiento mediante tratamientos automatizados destinados a recopilar información personal con el objetivo de predecir o evaluar sus preferencias o comportamientos.\nretargeting y remarketing: llegar al interesado que ya ha visitado o mostrado interés en los productos y/o servicios ofrecidos por la Aplicación utilizando sus Datos Personales con una publicidad personalizada. El interesado puede optar por no participar visitando la página de Network Advertising Initiative\nFines de marketing de los productos y/o servicios del Titular: enviar información o materiales comerciales y/o promocionales, realizar actividades de venta directa de los productos y/o servicios del Titular o realizar estudios de mercado utilizando métodos automatizados y tradicionales.\nFines de marketing de productos y/o servicios de terceros: enviar información o materiales comerciales y/o promocionales de terceros, realizar actividades de venta directa o realizar estudios de mercado de sus productos y/o servicios con métodos automatizados y tradicionales.\nLos Datos Personales del interesado también podrán ser utilizados por el Responsable del tratamiento para protegerse judicialmente ante las oficinas judiciales competentes.\n\nModalidades de Tratamiento y Destinatarios de los Datos Personales\nEl tratamiento de Datos Personales se realiza mediante papel y herramientas informáticas con métodos y lógicas organizativos estrictamente relacionados con las finalidades indicadas y mediante la adopción de medidas de seguridad adecuadas.\n\nLos Datos Personales son tratados exclusivamente por:\n\npersonas autorizadas por el Responsable del Tratamiento de Datos Personales que estén comprometidas con la confidencialidad o tengan una obligación legal adecuada de confidencialidad;\nsujetos que operan de forma independiente como responsables del tratamiento independientes o por sujetos designados como responsables del tratamiento por el Responsable del tratamiento con el fin de llevar a cabo todas las actividades de tratamiento necesarias para alcanzar los fines mencionados en esta información (por ejemplo, socios comerciales, consultores, empresas de TI, proveedores de servicios, proveedores de hosting);\nsujetos u organismos a quienes sea obligatorio comunicar Datos Personales por obligación legal o por orden de las autoridades.\nLos sujetos enumerados anteriormente están obligados a utilizar medidas de seguridad adecuadas para proteger los Datos personales y solo pueden acceder a aquellos necesarios para realizar las tareas que se les asignan.\n\nLos Datos Personales no serán divulgados indiscriminadamente de ninguna manera.\n\nLugar\nLos Datos Personales no serán objeto de ninguna transferencia fuera del territorio del Espacio Económico Europeo (EEE).\n\nPeríodo de conservación de datos personales\nLos Datos Personales se conservarán durante el tiempo necesario para cumplir con los fines para los que fueron recopilados, en particular:\n\na los efectos de la ejecución del contrato entre el Titular y el Interesado, se conservarán durante toda la duración de la relación contractual y, tras su extinción, durante el plazo de prescripción ordinario de 10 años. En el caso de litigio judicial, durante toda la duración del mismo, hasta que se agoten los plazos para recurrir\npara fines relacionados con el interés legítimo del Responsable del tratamiento, se conservarán hasta que se cumpla dicho interés\npara el cumplimiento de una obligación legal, por orden de una autoridad y para protección judicial, se conservarán en el cumplimiento de los plazos establecidos por dichas obligaciones, normas y en todo caso hasta el vencimiento del plazo de prescripción establecido por las normas en fuerza\npara fines basados ​​en el consentimiento del interesado, se conservarán hasta que se revoque el consentimiento\nAl final del período de retención, todos los Datos Personales serán eliminados o almacenados de una forma que no permita la identificación del interesado.\n\nDerechos del interesado\nLos interesados ​​pueden ejercer determinados derechos en relación con los Datos Personales tratados por el Titular. En particular, el interesado tiene derecho a:\n\nser informado sobre el tratamiento de sus Datos Personales\nrevocar su consentimiento en cualquier momento\nlimitar el procesamiento de sus Datos Personales\noponerse al procesamiento de sus Datos Personales\nacceder a sus datos personales\nverificar y solicitar la rectificación de sus Datos Personales\nobtener la limitación del tratamiento de sus Datos Personales\nobtener la eliminación de sus Datos Personales\ntransferir sus datos personales a otro propietario\npresentar una queja ante la autoridad de control de protección de sus Datos Personales y/o emprender acciones legales.\nPara ejercer sus derechos, los interesados ​​pueden enviar una solicitud a la siguiente dirección de correo electrónico info@bfwellness.it. Las solicitudes serán atendidas por el Responsable del tratamiento de forma inmediata y procesadas lo más rápidamente posible, en cualquier caso dentro de los 30 días.',
    },
    'tg0o5ell': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Search
  {
    'izy1bezx': {
      'it': 'VOI Tanak Village',
      'en': 'YOU Tanak Village',
      'es': 'Tú pueblo Tanak',
    },
    'wise63in': {
      'it': 'Cerca servizio o trattamento',
      'en': 'Seek service or treatment',
      'es': 'Buscar servicio o tratamiento',
    },
    'vgwoj12d': {
      'it': 'Ricerche recenti',
      'en': 'Recent research',
      'es': 'Investigación reciente',
    },
    'adh8lq7p': {
      'it': 'Cancella',
      'en': 'Cancel',
      'es': 'Cancelar',
    },
    '85m701tw': {
      'it': '+1 - 4842989351',
      'en': '+1 - 4842989351',
      'es': '+1 - 4842989351',
    },
    'nbk3skhy': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // SignIn
  {
    '8563db3h': {
      'it': 'Bentornato\n nelle strutture BF',
      'en': 'Welcome\n in a BF center',
      'es': 'Bienvenido\n en un centro BF',
    },
    '3oyl4dsi': {
      'it': 'Non hai ancora un account? ',
      'en': 'Don\'t have an account yet?',
      'es': '¿Aún no tienes una cuenta?',
    },
    'knnmarsx': {
      'it': 'Contattaci!',
      'en': 'Sign in!',
      'es': '¡Iniciar sesión!',
    },
    'e18kgsgr': {
      'it': 'Email',
      'en': 'Email',
      'es': 'Email',
    },
    'z9ky529t': {
      'it': 'Password',
      'en': 'Password',
      'es': 'Contraseña',
    },
    'tw5utsh8': {
      'it': 'Email obbligatoria',
      'en': 'Email required',
      'es': 'Email requerido',
    },
    'wy7a7k37': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'zew5fkeh': {
      'it': 'Password richiesta',
      'en': 'Password required',
      'es': 'Se requiere contraseña',
    },
    '94d1yzh2': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'a9ylspe3': {
      'it': 'Accedi con email',
      'en': 'Log in with email',
      'es': 'Iniciar sesión con email',
    },
    'modhnsxw': {
      'it': 'Hai dimenticato la tua password?',
      'en': 'Forgot your password?',
      'es': '¿Olvidaste tu password?',
    },
    'iu2zbl5p': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Languages
  {
    'u8iuop6t': {
      'it': 'Seleziona lingua',
      'en': 'Select language',
      'es': 'Seleccione el idioma',
    },
    'ozsfweyo': {
      'it': 'Italiano',
      'en': 'Italiano',
      'es': 'Italiano',
    },
    '1r6y7v0z': {
      'it': '',
      'en': 'Reorder your favorite service in a click',
      'es': '',
    },
    '1d60r7n2': {
      'it': 'English',
      'en': 'English',
      'es': 'English',
    },
    'l6vod0y7': {
      'it': '',
      'en': 'Reorder your favorite service in a click',
      'es': '',
    },
    'cnt44335': {
      'it': 'Español',
      'en': 'Español',
      'es': 'Español',
    },
    '7pqfbe7l': {
      'it': '',
      'en': 'Reorder your favorite service in a click',
      'es': '',
    },
    'uu93um3n': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // UpdateUserData
  {
    '9q04zjj0': {
      'it': 'Completa il tuo profilo',
      'en': 'Complete your profile',
      'es': 'completa tu perfil',
    },
    '47tihrp3': {
      'it': 'Nome',
      'en': 'First name',
      'es': 'Nombre',
    },
    'kp45sx4u': {
      'it': 'Cognome',
      'en': 'Surname',
      'es': 'Apellido',
    },
    'pcpioolk': {
      'it': 'Cellulare',
      'en': 'Mobile',
      'es': 'Teléfono móvil',
    },
    'veezy8f1': {
      'it': 'Field is required',
      'en': '',
      'es': '',
    },
    '67muxajx': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'kg4ze8pf': {
      'it': 'Field is required',
      'en': '',
      'es': '',
    },
    '0swmpx95': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'cbjbxvmi': {
      'it': 'Field is required',
      'en': '',
      'es': '',
    },
    'ya3tea7u': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'netyq9wy': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // LocationSearch
  {
    'vj62oufr': {
      'it': 'Seleziona indirizzo',
      'en': 'Select address',
      'es': 'Seleccionar dirección',
    },
    'v0sk6bq5': {
      'it': 'Digita il tuo indirizzo',
      'en': 'Type your address',
      'es': 'Escribe tu dirección',
    },
    '0ywtw5lq': {
      'it': 'Digita il tuo indirizzo',
      'en': 'Type your address',
      'es': 'Escribe tu dirección',
    },
    '0ad1gsgb': {
      'it': 'Royal Ln. Mesa',
      'en': 'Royal Ln. Mesa',
      'es': 'Calle Real. Colina baja',
    },
    'xorghxjt': {
      'it': '2464 Royal Ln. Mesa, New Jersey 45463',
      'en': '2464 Royal Ln. Mesa, New Jersey 45463',
      'es': '2464 Royal Ln. Mesa, Nueva Jersey 45463',
    },
    '41fz1u0b': {
      'it': 'Royal Ln. Mesa',
      'en': 'Royal Ln. Mesa',
      'es': 'Calle Real. Colina baja',
    },
    'e1t83f5d': {
      'it': '2464 Royal Ln. Mesa, New Jersey 45463',
      'en': '2464 Royal Ln. Mesa, New Jersey 45463',
      'es': '2464 Royal Ln. Mesa, Nueva Jersey 45463',
    },
    'p0p5c119': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // LocationMap
  {
    'u7r34x57': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // LocationPlacesMap
  {
    'oa5wpqrg': {
      'it': 'Seleziona indirizzo',
      'en': 'Select address',
      'es': 'Seleccionar dirección',
    },
    'lkrn0cfl': {
      'it': 'Digita il tuo indirizzo',
      'en': 'Type your address',
      'es': 'Escribe tu dirección',
    },
    'xugqaoqa': {
      'it': 'Digita il tuo indirizzo',
      'en': 'Type your address',
      'es': 'Escribe tu dirección',
    },
    'g2ttytkh': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Booking_service_selection
  {
    'ce7ofnqv': {
      'it': 'Nuova prenotazione',
      'en': 'New booking',
      'es': 'Nueva reserva',
    },
    '9f27d01v': {
      'it': 'Cliente',
      'en': 'Customer',
      'es': 'Cliente',
    },
    '53mry3xs': {
      'it': 'Cambia',
      'en': 'Change',
      'es': 'Cambiar',
    },
    'bcw94s8m': {
      'it': 'Trattamenti',
      'en': '',
      'es': '',
    },
    'hepkng05': {
      'it': 'Seleziona un trattamento',
      'en': 'Select a treatment',
      'es': 'Seleccione un tratamiento',
    },
    'yt4xmf0d': {
      'it': 'Cerca trattamento',
      'en': '',
      'es': '',
    },
    'ymatu39d': {
      'it': 'Pacchetti',
      'en': '',
      'es': '',
    },
    'lfd6pq0j': {
      'it': 'Seleziona un pacchetto',
      'en': 'Select a package',
      'es': 'Seleccione un paquete',
    },
    'sjrf25wf': {
      'it': 'Servizi',
      'en': '',
      'es': '',
    },
    'l85arrq5': {
      'it': 'Seleziona un servizio',
      'en': 'Select one or more products',
      'es': 'Seleccione uno o más productos',
    },
    'opo6exc1': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Booking_operators_selection
  {
    'n1l6c0ly': {
      'it': 'Scegli operatore',
      'en': 'Choose operator',
      'es': 'Elige operador',
    },
    'yh2ds49c': {
      'it': 'Chiudi',
      'en': 'Close',
      'es': 'Cerca',
    },
    '77hg4ixp': {
      'it': 'Disponibilità',
      'en': '',
      'es': '',
    },
    'kbobooxm': {
      'it': 'Vedi disponibilità',
      'en': 'See availability',
      'es': 'Ver disponibilidad',
    },
    'b2kjqffm': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Booking_date_selection
  {
    '3yy96jh7': {
      'it': 'Scegli data e ora',
      'en': 'Choose date and time',
      'es': 'Elige fecha y hora',
    },
    'whp2pmhh': {
      'it': '10:30',
      'en': '',
      'es': '',
    },
    'wvx2rkap': {
      'it': '11:50',
      'en': '',
      'es': '',
    },
    'arwh80r2': {
      'it': '14:00',
      'en': '',
      'es': '',
    },
    'kk39lj57': {
      'it': '14:30',
      'en': '',
      'es': '',
    },
    'bxa37jhh': {
      'it': '15:00',
      'en': '',
      'es': '',
    },
    '0fr9rlo5': {
      'it': '16:00',
      'en': '',
      'es': '',
    },
    '0tguvwgt': {
      'it': '16:30',
      'en': '',
      'es': '',
    },
    'x1ommuc3': {
      'it': '17:00',
      'en': '',
      'es': '',
    },
    '8ery3q1o': {
      'it': '17:30',
      'en': '',
      'es': '',
    },
    'wtbrxjoj': {
      'it': '18:00',
      'en': '',
      'es': '',
    },
    'wppa5rgt': {
      'it': 'Conferma',
      'en': 'Confirm',
      'es': 'Confirma',
    },
    'd56ks1v0': {
      'it': 'Nessun appuntamento disponibile oggi',
      'en': '',
      'es': '',
    },
    'jh39yjh3': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Booking_confirm
  {
    'nkhds385': {
      'it': 'Appuntamento confermato',
      'en': 'Appointment confirmed',
      'es': 'Cita confirmada',
    },
    'z8vt117i': {
      'it': 'Riepilogo appuntamento',
      'en': 'Appointment summary',
      'es': 'Resumen de la cita',
    },
    'i1ozfios': {
      'it': 'Prenota ancora (stesso cliente)',
      'en': 'Book again (same customer)',
      'es': 'Reservar nuevamente (mismo cliente)',
    },
    '8nlgd1sk': {
      'it': 'Scheda cliente',
      'en': 'Customer card',
      'es': 'tarjeta de cliente',
    },
    '52ow4ri1': {
      'it': 'Home',
      'en': 'Home',
      'es': 'Hogar',
    },
    'y5w0rqvz': {
      'it': 'Chiudi',
      'en': 'Close',
      'es': 'Cerca',
    },
    'djr2omwd': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Bookings_agenda
  {
    'mf7xa03e': {
      'it': 'Agenda prenotazioni',
      'en': 'Reservation agenda',
      'es': 'Agenda de reservas',
    },
    'gvfvn78j': {
      'it': 'Agenda',
      'en': '',
      'es': '',
    },
    'tl5r2jmh': {
      'it': 'Disponibilità appuntamenti',
      'en': '',
      'es': '',
    },
    'pajbpjly': {
      'it': 'Tipologia agenda',
      'en': '',
      'es': '',
    },
    'mj5o04sz': {
      'it': 'Vedi lista',
      'en': 'See list',
      'es': 'Ver lista',
    },
    'bd26p575': {
      'it': 'Trattamenti',
      'en': 'Treatments',
      'es': 'Tratos',
    },
    'a5fmk9ko': {
      'it': 'Ingressi',
      'en': 'Entrances',
      'es': 'Entradas',
    },
    'ea37pczp': {
      'it': 'Trattamenti',
      'en': '',
      'es': '',
    },
    '5qvo385g': {
      'it': 'I miei appuntamenti',
      'en': 'My appointments',
      'es': 'mis citas',
    },
    '5h1tddf4': {
      'it': 'Disponibilità',
      'en': 'Availability',
      'es': 'Disponibilidad',
    },
    'puoaye64': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Clients_old
  {
    's1875bne': {
      'it': 'VOI Tanak Village',
      'en': '',
      'es': '',
    },
    'pug8amtw': {
      'it': 'Cerca nome o email',
      'en': 'Seek service or treatment',
      'es': 'Buscar servicio o tratamiento',
    },
    'ehoqa78o': {
      'it': 'Ricerche recenti',
      'en': 'Recent research',
      'es': 'Investigación reciente',
    },
    'f6ci4vp5': {
      'it': 'Cancella',
      'en': 'Cancel',
      'es': 'Cancelar',
    },
    'r8pl5wuh': {
      'it': 'trade@shoplix.it',
      'en': '',
      'es': '',
    },
    '20eu7n01': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Clients
  {
    'ioavazci': {
      'it': 'Clienti',
      'en': 'Clients',
      'es': 'Clientela',
    },
    '5n5nbbwb': {
      'it': 'Clienti',
      'en': '',
      'es': '',
    },
    '2mhcq89v': {
      'it': 'Elenco clienti struttura',
      'en': '',
      'es': '',
    },
    'g7lb7fga': {
      'it': 'Cerca nome o email',
      'en': 'Seek service or treatment',
      'es': 'Buscar servicio o tratamiento',
    },
    'qugviy7i': {
      'it': 'Clienti',
      'en': 'Clients',
      'es': 'Clientela',
    },
  },
  // Booking_client_selection
  {
    'q4dnirop': {
      'it': 'Nuova prenotazione',
      'en': 'New booking',
      'es': 'Nueva reserva',
    },
    'hz627u4k': {
      'it': 'Cerca o crea un cliente',
      'en': 'Search or create a customer',
      'es': 'Buscar o crear un cliente',
    },
    'zyytlk64': {
      'it': 'Cerca nome o email',
      'en': 'Search name or email',
      'es': 'Buscar nombre o correo electrónico',
    },
    'po36e9e6': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Client_details
  {
    'ievkw931': {
      'it': 'Scheda cliente',
      'en': 'Customer card',
      'es': 'tarjeta de cliente',
    },
    '1uoit0el': {
      'it': 'Anagrafica',
      'en': 'Personal data',
      'es': 'Información personal',
    },
    'qxvjq5jx': {
      'it': 'Modifica',
      'en': 'Edit',
      'es': 'Editar',
    },
    '97y598yg': {
      'it': 'Storia del cliente',
      'en': 'Customer story',
      'es': 'Historia del cliente',
    },
    '7ulrw0ph': {
      'it': 'Storico pagamenti',
      'en': 'Payment history',
      'es': 'Historial de pagos',
    },
    'wsfpadsl': {
      'it': 'Storico transazioni e metodi di pagamento',
      'en': 'Transaction history and payment methods',
      'es': 'Historial de transacciones y métodos de pago.',
    },
    'a1tynle8': {
      'it': 'Riepilogo spese',
      'en': 'Expense summary',
      'es': 'Resumen de gastos',
    },
    'j9n6784j': {
      'it': 'Registro acquisti prodotti e trattamenti',
      'en': 'Product and treatment purchase register',
      'es': 'Registro de compra de productos y tratamientos',
    },
    'zkjhpofo': {
      'it': 'Appuntamenti',
      'en': 'Appointments',
      'es': 'Equipo',
    },
    'sq05n1ni': {
      'it': 'Elenco degli appuntamenti',
      'en': 'List of appointments',
      'es': 'Lista de citas',
    },
    '3zjrq54y': {
      'it': 'Da saldare',
      'en': 'To be paid',
      'es': 'A pagar',
    },
    '02t838mg': {
      'it': 'In regola con i pagamenti',
      'en': 'Up to date with payments',
      'es': 'Al corriente con los pagos',
    },
    '1w8ufimy': {
      'it': 'Incassa pagamento',
      'en': 'Collect payment',
      'es': 'Cobrar pago',
    },
    'smjr42l1': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Client_payments
  {
    '7jk69vuf': {
      'it': 'Storico pagamenti',
      'en': 'Payment history',
      'es': 'Historial de pagos',
    },
    'zlfwkk44': {
      'it': 'Cliente',
      'en': 'Customer',
      'es': 'Cliente',
    },
    's6a4ih2l': {
      'it': 'Pagamenti',
      'en': 'Payments',
      'es': 'Pagos',
    },
    'k70izncw': {
      'it': 'Sconto ',
      'en': '',
      'es': '',
    },
    '52h8gyis': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Client_bookings
  {
    'px22k55y': {
      'it': 'Storico prenotazioni',
      'en': 'Reservation history',
      'es': 'Historial de reservas',
    },
    'tv0whouu': {
      'it': 'Cliente',
      'en': 'Customer',
      'es': 'Cliente',
    },
    '9vjfky4u': {
      'it': 'Appuntamenti',
      'en': 'Entrances',
      'es': 'Entradas',
    },
    'yb4yiuza': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Client_create
  {
    'jymerpbk': {
      'it': 'Nuovo cliente',
      'en': 'New client',
      'es': 'Cliente nuevo',
    },
    '4va1n8zp': {
      'it': 'Dati cliente',
      'en': 'Customer data',
      'es': 'Datos de los clientes',
    },
    'zcnkz4ej': {
      'it': 'Nome',
      'en': 'First name',
      'es': 'Nombre de pila',
    },
    'hoeoed5z': {
      'it': '',
      'en': '',
      'es': '',
    },
    'kdxb2836': {
      'it': 'Cognome',
      'en': 'Surname',
      'es': 'Apellido',
    },
    'bjf1lbhb': {
      'it': 'Email',
      'en': 'E-mail',
      'es': 'Correo electrónico',
    },
    'byxibcth': {
      'it': 'Telefono',
      'en': 'Telephone',
      'es': 'Teléfono',
    },
    '03uq08n7': {
      'it': 'Numero di Camera',
      'en': 'Room number',
      'es': 'Número de habitación',
    },
    'egp5jy2t': {
      'it': 'Inizio soggiorno',
      'en': 'Start of stay',
      'es': 'inicio de estancia',
    },
    'hiag4lpw': {
      'it': 'Fine del soggiorno',
      'en': 'End of stay',
      'es': 'Fin de estancia',
    },
    'h3xpdchk': {
      'it': 'Campo obbligatorio',
      'en': '',
      'es': '',
    },
    '0j6j4cd2': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'pbhkejf4': {
      'it': 'Campo obbligatorio',
      'en': '',
      'es': '',
    },
    'k6q50h9o': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'am3ctusj': {
      'it': 'Campo obbligatorio',
      'en': '',
      'es': '',
    },
    'fpkogbhp': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'a36pl0uo': {
      'it': 'Campo obbligatorio',
      'en': '',
      'es': '',
    },
    'okwiozx6': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'hkrtp375': {
      'it': 'Campo obbligatorio',
      'en': '',
      'es': '',
    },
    '8o3xni7v': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'vxezwm0g': {
      'it': 'Field is required',
      'en': 'Required field',
      'es': 'Campo requerido',
    },
    'fennafey': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'k5ow5p4f': {
      'it': 'Field is required',
      'en': 'Required field',
      'es': 'Campo requerido',
    },
    'jessjjw5': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'rfilgcm0': {
      'it': 'Conferma',
      'en': 'Confirm',
      'es': 'Confirma',
    },
    '0rxmhcvv': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Bookings_list
  {
    'x7zmkf0w': {
      'it': 'Agenda prenotazioni',
      'en': 'Reservation agenda',
      'es': 'Agenda de reservas',
    },
    '942j8f9e': {
      'it': 'Vedi calendario',
      'en': 'See calendar',
      'es': 'Ver calendario',
    },
    'uzfrak2x': {
      'it': 'Appuntamenti',
      'en': 'Appointments',
      'es': 'Equipo',
    },
    'qrx37ca1': {
      'it': 'Mostra appuntamenti colleghi',
      'en': 'Show colleagues appointments',
      'es': 'Mostrar citas de colegas',
    },
    'kmdcgpp9': {
      'it': 'In arrivo',
      'en': '',
      'es': '',
    },
    'r24vfuzh': {
      'it': 'Passati',
      'en': '',
      'es': '',
    },
    'kyvpwsyx': {
      'it': 'Annullati',
      'en': '',
      'es': '',
    },
    'qsaibt5v': {
      'it': 'In arrivo',
      'en': 'Arriving',
      'es': 'Llegando',
    },
    '537mdi01': {
      'it': 'Passati',
      'en': 'Passed',
      'es': 'Aprobado',
    },
    'pfflrapd': {
      'it': 'Annullati',
      'en': 'Cancelled',
      'es': 'Cancelado',
    },
    '22u3enyu': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Booking_details
  {
    '960oil24': {
      'it': 'Dettagli appuntamento',
      'en': 'Appointment details',
      'es': 'Detalles de la cita',
    },
    '24cuumu1': {
      'it': 'Riepilogo appuntamento',
      'en': 'Appointment summary',
      'es': 'Resumen de la cita',
    },
    'vuqv9naa': {
      'it': 'Stato',
      'en': 'Help',
      'es': 'Ayuda',
    },
    '6a1t2uej': {
      'it': 'Annullato',
      'en': 'Cancelled',
      'es': 'Cancelado',
    },
    'cn06d9vm': {
      'it': 'Annullato da',
      'en': 'Canceled by',
      'es': 'Cancelado por',
    },
    'bjeixtcg': {
      'it': 'Motivo',
      'en': 'Reason',
      'es': 'Razón',
    },
    '52d6qzn7': {
      'it': 'Cambia data',
      'en': 'Change date',
      'es': 'Cambiar fecha',
    },
    'fq0rd1qc': {
      'it': 'Scheda cliente',
      'en': 'Customer card',
      'es': 'tarjeta de cliente',
    },
    'wow5xl65': {
      'it': 'Annulla',
      'en': 'Cancel',
      'es': 'Cancelar',
    },
    '2s7i2n1p': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Payment_create
  {
    'u2ee08or': {
      'it': 'Registra pagamento',
      'en': 'Record payment',
      'es': 'Pago récord',
    },
    '9ldiitwd': {
      'it': 'Dati cliente',
      'en': 'Customer data',
      'es': 'Datos de los clientes',
    },
    'fjgyg28p': {
      'it': 'Stato pagamenti',
      'en': 'Payment status',
      'es': 'Estado de pago',
    },
    'gfbi2b8d': {
      'it': 'Vedi i pagamenti',
      'en': 'See payments',
      'es': 'Ver pagos',
    },
    'faed00mt': {
      'it': 'Già pagato',
      'en': 'Already paid',
      'es': 'Ya pagado',
    },
    'k9zrphnm': {
      'it': 'Da pagare',
      'en': 'To pay',
      'es': 'Pagar',
    },
    '4go5m46b': {
      'it': 'Dettagli pagamento',
      'en': 'Payment details',
      'es': 'Detalles del pago',
    },
    'kilu6r3a': {
      'it': 'Note',
      'en': 'Note',
      'es': 'Nota',
    },
    'vpovm46c': {
      'it': 'Paga ora',
      'en': 'Pay now',
      'es': 'Pagar ahora',
    },
    '3t89mwcp': {
      'it': 'Sconto',
      'en': 'Discount',
      'es': 'Descuento',
    },
    '22wgmu3u': {
      'it': '0',
      'en': '0',
      'es': '0',
    },
    'o32veh1h': {
      'it': 'Contanti',
      'en': 'Cash',
      'es': 'Dinero',
    },
    '6pknncmu': {
      'it': 'Carta di credito',
      'en': 'Paper',
      'es': 'Papel',
    },
    'tsvxl5tx': {
      'it': 'Monetica',
      'en': 'Room charge',
      'es': 'Precio de la habitación',
    },
    '97w2wnww': {
      'it': 'Addebito in camera',
      'en': '',
      'es': '',
    },
    'wl74tdhl': {
      'it': 'Immettere una quantità valida',
      'en': 'Please enter a valid quantity',
      'es': 'Por favor introduce una cantidad válida',
    },
    'ymnz9e8v': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    '6evrifm4': {
      'it': 'Field is required',
      'en': 'Required field',
      'es': 'Campo requerido',
    },
    'k353aah9': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'fpqv46jd': {
      'it': 'Conferma',
      'en': 'Confirm',
      'es': 'Confirma',
    },
    'agr9k4m2': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Payment_confirm
  {
    'd2w1gwgg': {
      'it': 'Pagamento registrato',
      'en': 'Payment recorded',
      'es': 'Pago registrado',
    },
    'rt7o1jd7': {
      'it': 'Riepilogo pagamento',
      'en': 'Payment summary',
      'es': 'Resumen de pago',
    },
    'b0ojgzmd': {
      'it': 'Sconto ',
      'en': '',
      'es': '',
    },
    'grptx24z': {
      'it': 'Registra nuovo pagamento',
      'en': 'Record new payment',
      'es': 'Registrar nuevo pago',
    },
    'avdz4jgs': {
      'it': 'Scheda cliente',
      'en': 'Customer details',
      'es': 'tarjeta de cliente',
    },
    'ljkp4w0e': {
      'it': 'Home',
      'en': 'Home',
      'es': 'Home',
    },
    'v6c6eopp': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Client_edit
  {
    'am44wnlo': {
      'it': 'Modifica cliente',
      'en': 'Edit customer',
      'es': 'Editar cliente',
    },
    'h4ruanpr': {
      'it': 'Dati cliente',
      'en': 'Customer data',
      'es': 'Datos de los clientes',
    },
    '1th5jaqf': {
      'it': 'Nome',
      'en': 'First name',
      'es': 'Nombre de pila',
    },
    'n2qnbu6x': {
      'it': 'Cognome',
      'en': 'Surname',
      'es': 'Apellido',
    },
    'ccvvobar': {
      'it': 'Email',
      'en': 'E-mail',
      'es': 'Correo electrónico',
    },
    'dyrl86qp': {
      'it': 'Telefono',
      'en': 'Telephone',
      'es': 'Teléfono',
    },
    '1s1s42o7': {
      'it': 'Numero di Camera',
      'en': 'Room number',
      'es': 'Número de habitación',
    },
    '56dnpwcx': {
      'it': 'Inizio soggiorno',
      'en': 'Start of stay',
      'es': 'inicio de estancia',
    },
    '72ww7bvz': {
      'it': 'Fine del soggiorno',
      'en': 'End of stay',
      'es': 'Fin de estancia',
    },
    '39samijz': {
      'it': 'Campo obbligatorio',
      'en': '',
      'es': '',
    },
    '9xqyi2ao': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'og2nlemn': {
      'it': 'Campo obbligatorio',
      'en': '',
      'es': '',
    },
    'xnxfno7w': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'ahe6abbb': {
      'it': 'Field is required',
      'en': 'Required field',
      'es': 'Campo requerido',
    },
    'cqmqipwu': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    '44opwsoo': {
      'it': 'Field is required',
      'en': 'Required field',
      'es': 'Campo requerido',
    },
    'oscyul4c': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    '33zjqvk2': {
      'it': 'Campo obbligatorio',
      'en': '',
      'es': '',
    },
    '4rz82iaa': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'r2zcvq8k': {
      'it': 'Field is required',
      'en': '',
      'es': '',
    },
    '8qnnf5bp': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'rsijx1pw': {
      'it': 'Field is required',
      'en': '',
      'es': '',
    },
    'yxluidoc': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    't4v60jak': {
      'it': 'Conferma',
      'en': 'He confirms',
      'es': 'el confirma',
    },
    'smxjw70a': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Booking_cancel
  {
    'dkwzy3l8': {
      'it': 'Annulla appuntamento',
      'en': 'Cancel appointment',
      'es': 'Cancelar cita',
    },
    'pbiqirml': {
      'it': 'Riepilogo appuntamento',
      'en': '',
      'es': '',
    },
    'w5wzvhez': {
      'it': 'Chi ha causato l\'annullamento?',
      'en': 'Who caused the cancellation?',
      'es': '¿Quién provocó la cancelación?',
    },
    'r6mclp0m': {
      'it': 'Cliente',
      'en': 'Customer',
      'es': 'Cliente',
    },
    '4u26nwxv': {
      'it': 'Operatore BF Wellness',
      'en': 'BF Wellness operator',
      'es': 'Operador BF Wellness',
    },
    '0e6tab66': {
      'it': 'Motivo dell\'annullamento',
      'en': 'Reason for cancellation',
      'es': 'Razón de la cancelación',
    },
    '47tuh3cc': {
      'it': 'Annulla appuntamento',
      'en': 'Cancel appointment',
      'es': 'Cancelar cita',
    },
    'al5f9iki': {
      'it': 'Field is required',
      'en': 'Required field',
      'es': 'Campo requerido',
    },
    'izbdldsu': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'xnsmgpz8': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Client_sales
  {
    'h6koaxxk': {
      'it': 'Riepilogo acquisti',
      'en': 'Purchase summary',
      'es': 'Resumen de compra',
    },
    'vq19mzle': {
      'it': 'Cliente',
      'en': 'Customer',
      'es': 'Cliente',
    },
    'w74fbbaz': {
      'it': 'Acquisti',
      'en': 'Acquisitions',
      'es': 'Adquisiciones',
    },
    'wnfazt80': {
      'it': 'Acquisto di prodotti',
      'en': 'Purchase of products',
      'es': 'Compra de productos',
    },
    'rrzf7vv7': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Sale_details
  {
    'yu1bylby': {
      'it': 'Dettagli vendita',
      'en': 'Sale details',
      'es': 'Detalles de venta',
    },
    'a0ascdfa': {
      'it': 'Riepilogo',
      'en': 'Summary',
      'es': 'Resumen',
    },
    '2ox6htx8': {
      'it': 'Trattamenti',
      'en': 'Treatments',
      'es': 'Tratos',
    },
    'r65h4rzm': {
      'it': 'Prodotti',
      'en': 'Products',
      'es': 'Productos',
    },
    '4crgzlu1': {
      'it': 'Importo rimborsato',
      'en': 'Amount refunded',
      'es': 'Cantidad reembolsada',
    },
    'wzm7ar7o': {
      'it': 'Totale',
      'en': 'Total',
      'es': 'Total',
    },
    'hlh5qvci': {
      'it': 'Scheda cliente',
      'en': 'Client details',
      'es': 'tarjeta de cliente',
    },
    'o59me11d': {
      'it': 'Home',
      'en': 'Home',
      'es': 'Home',
    },
    'v6u7arhp': {
      'it': 'Rimborso',
      'en': 'Home',
      'es': 'Hogar',
    },
    '1mvcnulx': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Sale_confirm
  {
    'l9ng5aph': {
      'it': 'Vendita confermata',
      'en': 'Sale confirmed',
      'es': 'Venta confirmada',
    },
    '6pkq7i0q': {
      'it': 'Appuntamenti confermati',
      'en': 'Appointments confirmed',
      'es': 'Citas confirmadas',
    },
    'o9x90goy': {
      'it': 'Riepilogo',
      'en': 'Summary',
      'es': 'Resumen',
    },
    'axcim22x': {
      'it': 'Trattamenti',
      'en': 'Treatments',
      'es': 'Tratos',
    },
    'nqtwjebq': {
      'it': 'Prodotti',
      'en': 'Products',
      'es': 'Productos',
    },
    'k1gmhge8': {
      'it': 'Totale',
      'en': 'Total',
      'es': 'Total',
    },
    'svc6az76': {
      'it': 'Scheda cliente',
      'en': 'Customer card',
      'es': 'tarjeta de cliente',
    },
    'kmh8l25k': {
      'it': 'Home',
      'en': 'Home',
      'es': 'Home',
    },
    'qkp8akgd': {
      'it': 'Prenota ancora (stesso cliente)',
      'en': 'Book again (same customer)',
      'es': 'Reservar nuevamente (mismo cliente)',
    },
    'cg2n13h7': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Booking_reschedule_operators_selection
  {
    'it532xa2': {
      'it': 'Scegli operatore',
      'en': 'Choose operator',
      'es': 'Elige operador',
    },
    'wrtp2gto': {
      'it': 'Chiudi',
      'en': 'Close',
      'es': 'Cerca',
    },
    '2qrx20bd': {
      'it': 'Disponibilità',
      'en': '',
      'es': '',
    },
    'w7jrrna1': {
      'it': 'Vedi disponibilità',
      'en': 'See availability',
      'es': 'Ver disponibilidad',
    },
    'e53u36z0': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Booking_reschedule_date_selection
  {
    'd0n125ul': {
      'it': 'Scegli data e ora',
      'en': 'Choose date and time',
      'es': 'Elige fecha y hora',
    },
    '4abgxawa': {
      'it': '10:30',
      'en': '',
      'es': '',
    },
    'cpcstb6d': {
      'it': '11:50',
      'en': '',
      'es': '',
    },
    'q5bjo5rv': {
      'it': '14:00',
      'en': '',
      'es': '',
    },
    'f4mzgt7n': {
      'it': '14:30',
      'en': '',
      'es': '',
    },
    '8kliir08': {
      'it': '15:00',
      'en': '',
      'es': '',
    },
    '2xntfdhf': {
      'it': '16:00',
      'en': '',
      'es': '',
    },
    '0e8aqse5': {
      'it': '16:30',
      'en': '',
      'es': '',
    },
    'b0axvohn': {
      'it': '17:00',
      'en': '',
      'es': '',
    },
    'xxen90r1': {
      'it': '17:30',
      'en': '',
      'es': '',
    },
    'wgoivwdp': {
      'it': '18:00',
      'en': '',
      'es': '',
    },
    'dvrhb0fe': {
      'it': 'Conferma',
      'en': 'He confirms',
      'es': 'el confirma',
    },
    'wxokzgow': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Help
  {
    'w938ty6t': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Test
  {
    'kdw4odyy': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Training
  {
    'hiwb49jl': {
      'it': 'Formazione',
      'en': '',
      'es': '',
    },
    'lqy9jn8q': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // TrainingPlayer
  {
    'tcn4qg7g': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Second_bookings_agenda
  {
    '4pr6yv9l': {
      'it': 'Agenda Ingressi',
      'en': 'Service agenda',
      'es': 'Agenda de servicio',
    },
    '4xnmk3u3': {
      'it': 'Agenda',
      'en': '',
      'es': '',
    },
    'gn12vvvs': {
      'it': 'Disponibilità appuntamenti',
      'en': '',
      'es': '',
    },
    '4j8019ge': {
      'it': 'Tipologia agenda',
      'en': 'Treatments',
      'es': 'Tratos',
    },
    'a5mgdju4': {
      'it': 'Vedi lista',
      'en': 'See list',
      'es': 'Ver lista',
    },
    '8xzr8xsl': {
      'it': 'Trattamenti',
      'en': 'Treatments',
      'es': 'Tratos',
    },
    's7i4s09q': {
      'it': 'Ingressi',
      'en': '',
      'es': '',
    },
    '0og9mxlj': {
      'it': 'Ingressi',
      'en': '',
      'es': '',
    },
    'vh9d3bxy': {
      'it': 'Categorie servizi',
      'en': '',
      'es': '',
    },
    'kvzyrs72': {
      'it': 'Disponibilità',
      'en': '',
      'es': '',
    },
    'xukk2dnk': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // Second_bookings_list
  {
    '10tqqcx0': {
      'it': 'Agenda servizi',
      'en': 'Service agenda',
      'es': 'Agenda de servicio',
    },
    'thuiwvpl': {
      'it': 'Vedi calendario',
      'en': 'See calendar',
      'es': 'Ver calendario',
    },
    'xdll1xt7': {
      'it': 'Ingressi',
      'en': 'Appointments',
      'es': 'Equipo',
    },
    'z8el2aq7': {
      'it': 'In arrivo',
      'en': 'Arriving',
      'es': 'Llegando',
    },
    '6f1h4ojc': {
      'it': 'Passati',
      'en': 'Passed',
      'es': 'Aprobado',
    },
    'izpymgwj': {
      'it': 'Annullati',
      'en': 'Cancelled',
      'es': 'Cancelado',
    },
    'ct344ipp': {
      'it': 'Home',
      'en': '',
      'es': '',
    },
  },
  // ServicesList
  {
    'z26vs4vo': {
      'it': 'Descrizione',
      'en': '',
      'es': '',
    },
    '3smj3zg7': {
      'it': '€',
      'en': '',
      'es': '',
    },
  },
  // ToCollect
  {
    'wdkajrpa': {
      'it': 'Da incassare',
      'en': 'To collect',
      'es': 'Sacar provecho de',
    },
  },
  // EmptyAppointments
  {
    '2mdifamj': {
      'it': 'Nessun appuntamento',
      'en': 'No appointments',
      'es': 'Sin citas',
    },
    'qkz3spi3': {
      'it': 'Non  è stato trovato nessun appuntamento',
      'en': 'No appointments found',
      'es': 'No se encontraron citas',
    },
  },
  // EmptyPayments
  {
    'nkufqh1p': {
      'it': 'Nessun pagamento',
      'en': 'No payment',
      'es': 'Sin pago',
    },
    'jx61ilzr': {
      'it': 'Non  è stato trovato nessun pagamento',
      'en': 'No payment found',
      'es': 'No se encontró ningún pago',
    },
  },
  // Dashboard_appointments
  {
    'z1ruxrca': {
      'it': 'Current Update',
      'en': 'Current Update',
      'es': 'Actualización actual',
    },
    '3wi9pdn8': {
      'it': 'An overview of your route.',
      'en': 'An overview of your route.',
      'es': 'Una visión general de su ruta.',
    },
    '5pbz5qjx': {
      'it': '12/62',
      'en': '12/62',
      'es': '12/62',
    },
    '7op13wle': {
      'it': 'Route progress',
      'en': 'Route progress',
      'es': 'Progreso de la ruta',
    },
    'sv2f8qmh': {
      'it': '18',
      'en': '18',
      'es': '18',
    },
    'x5318cor': {
      'it': 'Tasks to be completed',
      'en': 'Tasks to be completed',
      'es': 'Tareas por completar',
    },
  },
  // ToCollectAmount
  {
    'gzap5wln': {
      'it': 'Da incassare',
      'en': 'To cash in',
      'es': 'Sacar provecho de',
    },
  },
  // PackagesList
  {
    '6ybbzge3': {
      'it': 'Descrizione',
      'en': '',
      'es': '',
    },
    'nii6ck83': {
      'it': '€',
      'en': '',
      'es': '',
    },
  },
  // RefundAmount
  {
    'v9u70od6': {
      'it': 'Importo rimborsato',
      'en': 'Amount refunded',
      'es': 'Cantidad reembolsada',
    },
    'ar50q13e': {
      'it': 'Importo da rimborsare',
      'en': 'Amount to be refunded',
      'es': 'Monto a reembolsar',
    },
    '9rdynhs2': {
      'it': 'Motivo del rimborso',
      'en': 'Reason for refund',
      'es': 'Motivo de reembolso',
    },
    'wybg0wmi': {
      'it': 'Rimborso',
      'en': 'Reimbursement',
      'es': 'Reembolso',
    },
    'b8jz8y9i': {
      'it': 'Field is required',
      'en': 'Required field',
      'es': 'Campo requerido',
    },
    'wyw5vt3g': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
    'w4fnt5y4': {
      'it': 'Field is required',
      'en': '',
      'es': '',
    },
    'w5v5n35b': {
      'it': 'Please choose an option from the dropdown',
      'en': '',
      'es': '',
    },
  },
  // SideNavBar
  {
    'yls4uf5k': {
      'it': 'Home',
      'en': 'Home',
      'es': 'Hogar',
    },
    'ylunwx41': {
      'it': 'Home',
      'en': 'Home',
      'es': 'Hogar',
    },
    'dx4r12pk': {
      'it': 'Agenda',
      'en': 'Agenda',
      'es': 'Agenda',
    },
    'e2o5mg4h': {
      'it': 'Agenda',
      'en': 'Agenda',
      'es': 'Agenda',
    },
    '7p0ic7f9': {
      'it': 'Clienti',
      'en': 'Clients',
      'es': 'Clientela',
    },
    'il84oemo': {
      'it': 'Clienti',
      'en': 'Clients',
      'es': 'Clientela',
    },
    '7w33hx7g': {
      'it': 'Il mio account',
      'en': 'my account',
      'es': 'mi cuenta',
    },
  },
  // TopNavBar
  {
    '6zo30f2l': {
      'it': 'Gestione struttura',
      'en': 'Scalea Village',
      'es': 'Pueblo de escala',
    },
    'hnqcm7gl': {
      'it': 'Formazione',
      'en': 'Training',
      'es': 'Capacitación',
    },
    'tlg5cmxl': {
      'it': 'Aiuto e supporto',
      'en': 'Help and support',
      'es': 'Ayuda y apoyo',
    },
  },
  // EmptyAccomodations
  {
    '5l52wrnb': {
      'it': 'Nessuna struttura assegnata',
      'en': '',
      'es': '',
    },
    'tqg2trga': {
      'it':
          'Non  è stata trovata alcuna struttura \n assegnata alla tua utenza. \n\nContatta lo staff di BF per ulteriori informazioni.',
      'en': '',
      'es': '',
    },
  },
  // EmptyClients
  {
    'o3ivhdqp': {
      'it': 'Nessun cliente',
      'en': '',
      'es': '',
    },
    'w2jfcz71': {
      'it': 'Non  è stato trovato nessun cliente per questa struttura',
      'en': '',
      'es': '',
    },
  },
  // ServiceListSearchResults
  {
    '1sv4m2mw': {
      'it': 'Descrizione',
      'en': '',
      'es': '',
    },
    '8slr68k9': {
      'it': '€',
      'en': '',
      'es': '',
    },
  },
  // NoWorkersServicesList
  {
    'tgpvynar': {
      'it': 'Descrizione',
      'en': '',
      'es': '',
    },
    '9jkjjk1c': {
      'it': '€',
      'en': '',
      'es': '',
    },
  },
  // Miscellaneous
  {
    '1o0dr8zp': {
      'it': 'Button',
      'en': 'Home',
      'es': 'Home',
    },
    't7fd55zd': {
      'it': 'Button',
      'en': 'See availability',
      'es': 'Ver disponibilidad',
    },
    'zud7gjx7': {
      'it': '',
      'en': '',
      'es': '',
    },
    'y89bcm1c': {
      'it': '',
      'en': '',
      'es': '',
    },
    'm5fqftxs': {
      'it': '',
      'en': '',
      'es': '',
    },
    'x7r468hw': {
      'it': '',
      'en': '',
      'es': '',
    },
    'e2clnn5o': {
      'it': '',
      'en': '',
      'es': '',
    },
    '3go3ddai': {
      'it': '',
      'en': '',
      'es': '',
    },
    'kwytxxd2': {
      'it': '',
      'en': '',
      'es': '',
    },
    'pwwi4whp': {
      'it': '',
      'en': '',
      'es': '',
    },
    '21a9rmjv': {
      'it': '',
      'en': '',
      'es': '',
    },
    'biigqp8a': {
      'it': '',
      'en': '',
      'es': '',
    },
    '00y8k0mg': {
      'it': '',
      'en': '',
      'es': '',
    },
    'phb2c97e': {
      'it': '',
      'en': '',
      'es': '',
    },
    'z5hrhaqf': {
      'it': '',
      'en': '',
      'es': '',
    },
    'zxvqwid3': {
      'it': '',
      'en': '',
      'es': '',
    },
    'hxdcmge8': {
      'it': '',
      'en': '',
      'es': '',
    },
    'xjixlkwv': {
      'it': '',
      'en': '',
      'es': '',
    },
    '718qkbsq': {
      'it': '',
      'en': '',
      'es': '',
    },
    '0uap94rv': {
      'it': '',
      'en': '',
      'es': '',
    },
    'sdgkbwbo': {
      'it': '',
      'en': '',
      'es': '',
    },
    'n5txkviu': {
      'it': '',
      'en': '',
      'es': '',
    },
    'pkpi1996': {
      'it': '',
      'en': '',
      'es': '',
    },
    'yn9gjysl': {
      'it': '',
      'en': '',
      'es': '',
    },
    '0pwdohjl': {
      'it': '',
      'en': '',
      'es': '',
    },
    '7tsq4n1o': {
      'it': '',
      'en': '',
      'es': '',
    },
    'dzxw20ga': {
      'it': '',
      'en': '',
      'es': '',
    },
    '0bpwdzri': {
      'it': '',
      'en': '',
      'es': '',
    },
    'up9bunis': {
      'it': '',
      'en': '',
      'es': '',
    },
    'fbatm1tz': {
      'it': '',
      'en': '',
      'es': '',
    },
  },
].reduce((a, b) => a..addAll(b));
