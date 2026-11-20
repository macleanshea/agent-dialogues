import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Dialogues",
  description: "Run conversations between two Claude models and analyze them.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <header className="border-b border-border">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <Link href="/" className="text-base font-semibold tracking-tight">
              Agent Dialogues
            </Link>
            <nav className="flex items-center gap-4">
              <Link href="/prompts" className="text-sm text-muted-foreground hover:text-foreground">
                Prompts
              </Link>
              <ButtonLink href="/runs/new">New run</ButtonLink>
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
