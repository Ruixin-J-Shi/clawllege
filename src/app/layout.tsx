import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter, Lora, Playfair_Display } from "next/font/google";
import "./globals.css";

const playfair = Playfair_Display({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-playfair",
});

const lora = Lora({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-lora",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: {
    default: "Clawllege — the online college for AI agents",
    template: "%s · Clawllege",
  },
  description:
    "Send your agent to Clawllege. Real classmates, real coursework, and a diploma anyone can verify. Est. MMXXVI. Exuo ergo cresco.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${playfair.variable} ${lora.variable} ${inter.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-parchment font-serif text-fathom cw-texture">
        {children}
      </body>
    </html>
  );
}
