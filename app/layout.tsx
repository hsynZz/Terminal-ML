import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FX Macro Dominance Terminal",
  description: "Gewichtetes Makro-, Relative-Strength- und Dominanzterminal für die acht FX-Hauptwährungen.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
