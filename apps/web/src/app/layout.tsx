import type { Metadata } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const siteName = "Oncall Triage Dashboard";
const siteDescription =
  "Monitor on-call alerts, integrations, and automated Datadog investigations from one focused dashboard.";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space",
  subsets: ["latin"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: siteName,
    template: `%s | ${siteName}`,
  },
  description: siteDescription,
  applicationName: siteName,
  keywords: [
    "on-call",
    "incident response",
    "triage",
    "Datadog",
    "alerts",
    "runbooks",
    "operations dashboard",
  ],
  category: "Operations",
  openGraph: {
    title: siteName,
    description: siteDescription,
    type: "website",
    siteName,
  },
  twitter: {
    card: "summary",
    title: siteName,
    description: siteDescription,
  },
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
  },
};

const themeScript = `
(() => {
  try {
    const stored = localStorage.getItem("triage-theme");
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = stored || (prefersDark ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  } catch {
    // no-op
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <body className={`${spaceGrotesk.variable} ${plexMono.variable} antialiased`}>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}
