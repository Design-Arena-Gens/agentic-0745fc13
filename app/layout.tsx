import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ChatGPT Local Replica",
  description: "ChatGPT UI replica with local history storage"
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="theme-dark">{children}</body>
    </html>
  );
}
