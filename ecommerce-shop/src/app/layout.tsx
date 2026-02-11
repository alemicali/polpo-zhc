import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ferramenta Online - Tutto per il fai da te",
  description: "Ferramenta Online: scopri la nostra vasta gamma di prodotti per edilizia, giardinaggio e fai da te. Qualità garantita e spedizione rapida.",
  keywords: ["ferramenta", "fai da te", "utensili", "edilizia", "giardinaggio"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
