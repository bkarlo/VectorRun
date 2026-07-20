import { Source_Sans_3, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import type { Metadata } from "next";
import "./globals.css";

const sans = Source_Sans_3({
  subsets: ["latin"],
  variable: "--font-sans",
});

const display = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-display",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "VectorRun",
  description: "Orienteering route coaching — compare decisions, not just times.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${sans.variable} ${display.variable} ${mono.variable} font-sans antialiased bg-forest-50 text-forest-950`}
      >
        {children}
      </body>
    </html>
  );
}
