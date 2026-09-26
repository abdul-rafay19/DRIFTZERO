import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DriftZero — AI-Powered Migration Engine",
  description: "Autonomous SDK/API Migration Platform powered by IBM Bob",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
