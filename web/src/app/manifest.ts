import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Listas compartilhadas",
    short_name: "Listas",
    description: "Listas compartilhadas em tempo real.",
    lang: "pt-BR",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#eef1f6",
    theme_color: "#eef1f6",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    // Long-press on the home screen icon (Android, Windows, macOS dock). HomeView opens the sheet for ?nova.
    shortcuts: [
      {
        name: "Nova lista",
        short_name: "Nova lista",
        description: "Criar uma lista",
        url: "/?nova",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
