import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ...Object.fromEntries(
          [
            "background",
            "foreground",
            "card",
            "popover",
            "primary",
            "secondary",
            "muted",
            "accent",
            "destructive",
            "border",
            "input",
            "ring",
          ].map((k) => [
            k,
            {
              DEFAULT: `hsl(var(--${k}))`,
              foreground: `hsl(var(--${k}-foreground))`,
            },
          ]),
        ),
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
    },
  },
  plugins: [animate],
} satisfies Config;
