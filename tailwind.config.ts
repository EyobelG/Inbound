import type { Config } from "tailwindcss";

import { MBTA_LINE_COLORS } from "./src/lib/mbta/colors";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        mbta: MBTA_LINE_COLORS,
        border: "hsl(var(--border))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
      },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" },
      keyframes: {
        "dash-march": { to: { strokeDashoffset: "-16" } },
      },
      animation: { "dash-march": "dash-march 1s linear infinite" },
    },
  },
  plugins: [],
};

export default config;
