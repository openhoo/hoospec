import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Hoospec — Gemeinsam Klarheit schaffen",
  description: "Das gemeinsame Studio für lebendige Gherkin-Specs und Architekturentscheidungen.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="de"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col"><script dangerouslySetInnerHTML={{ __html: `(()=>{let t='system';try{t=localStorage.getItem('hoospec-theme')||t}catch{}if(!['light','dark','system'].includes(t))t='system';document.documentElement.dataset.theme=t;document.documentElement.classList.toggle('dark',t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches))})()` }}/>{children}</body>
    </html>
  );
}
