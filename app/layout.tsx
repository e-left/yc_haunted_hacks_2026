import type { Metadata } from "next";
import "./storefront.css";

export const metadata: Metadata = {
  title: "Amazombie | T-shirts for the living",
  description: "Amazombie merchant API demo",
  icons: { icon: "/assets/amazombie-logo.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
