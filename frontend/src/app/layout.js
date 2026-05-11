import { Geist, EB_Garamond } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import ImpersonationBanner from "@/components/ImpersonationBanner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const ebGaramond = EB_Garamond({
  variable: "--font-eb-garamond",
  subsets: ["latin"],
  weight: ["500", "600"],
});

export const metadata = {
  title: "THE PARKLANE CANVAS",
  description: "AI-driven software development lifecycle platform",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${ebGaramond.variable} h-full antialiased`}>
      <body className="min-h-full bg-gray-50" suppressHydrationWarning>
        <AuthProvider>
          <ImpersonationBanner />
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
