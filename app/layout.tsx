import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Compliment Sandwich",
  description: "A tiny retro website where you can pay to receive a live compliment by phone."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
