import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Water, Listening",
  description:
    "An audio-reactive water reflection made with p5.js, WebGL, and the Web Audio API.",
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

