import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Between the Lines — a second opinion on your chat",
  description:
    "A thoughtful, funny read on the patterns hiding in your WhatsApp conversation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
