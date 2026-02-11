export default function Home() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-blue-600 text-white py-6 shadow-md">
        <div className="container mx-auto px-4">
          <h1 className="text-3xl font-bold">Ferramenta Online</h1>
          <p className="text-blue-100 text-sm mt-1">Il tuo negozio di fiducia</p>
        </div>
      </header>

      {/* Hero Section */}
      <main className="flex-grow">
        <section className="bg-gradient-to-b from-gray-50 to-white py-20">
          <div className="container mx-auto px-4 text-center">
            <h2 className="text-4xl md:text-5xl font-bold text-gray-800 mb-6">
              Benvenuti alla Ferramenta Online
            </h2>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto mb-8">
              Scopri la nostra vasta gamma di prodotti per il fai da te, l'edilizia e il giardinaggio.
              Qualità professionale, prezzi competitivi.
            </p>
            <button className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-8 rounded-lg transition duration-200">
              Scopri i Prodotti
            </button>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-gray-800 text-gray-300 py-6">
        <div className="container mx-auto px-4 text-center">
          <p className="text-sm">
            &copy; {new Date().getFullYear()} Ferramenta Online. Tutti i diritti riservati.
          </p>
        </div>
      </footer>
    </div>
  );
}
