/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Hanken Grotesk', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        // Literary serif retired per brand v2 — `font-serif` now renders Hanken Grotesk.
        serif: ['Hanken Grotesk', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // The app's micro type scale, named after years of drift toward the same
      // five arbitrary values (text-[10px] ×346, text-[11px] ×300, …). Plain
      // strings, not [size, line-height] tuples: arbitrary text-[Npx] only set
      // font-size and inherited line-height, so tuples would silently change
      // leading at hundreds of call sites. No new arbitrary text-[Npx] — pick
      // the nearest step.
      fontSize: {
        tiny: '9px',
        micro: '10px',
        label: '11px',
        caption: '12px',
        'body-sm': '13px',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        // Card/Panel radius. Resolves to the same 12px as stock rounded-xl at
        // --radius: 10px, but keeps every container on the ladder if upstream
        // ever retunes --radius.
        xl: 'calc(var(--radius) + 2px)',
      },
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        // Validation-layer fail accent (see --clay in index.css)
        clay: 'hsl(var(--clay))',
        // Agenda type identity hues (see index.css) — identity only, never verdicts.
        type: {
          release: 'hsl(var(--type-release))',
          process: 'hsl(var(--type-process))',
          trade: 'hsl(var(--type-trade))',
          message: 'hsl(var(--type-message))',
          notification: 'hsl(var(--type-notification))',
        },
        // Surface levels for layered depth
        surface: {
          1: 'hsl(var(--surface-1))',
          2: 'hsl(var(--surface-2))',
          3: 'hsl(var(--surface-3))',
          // Sidebar chrome (see --surface-rail in index.css)
          rail: 'hsl(var(--surface-rail))',
        },
      },
      boxShadow: {
        'glow': '0 0 20px -5px hsl(var(--ring) / 0.3)',
        'glow-lg': '0 0 40px -10px hsl(var(--ring) / 0.4)',
        'inner-glow': 'inset 0 1px 0 0 hsl(var(--foreground) / 0.05)',
        'card': '0 2px 8px -2px hsl(var(--shadow-color) / 0.1), 0 4px 16px -4px hsl(var(--shadow-color) / 0.1)',
        'card-hover': '0 4px 12px -2px hsl(var(--shadow-color) / 0.15), 0 8px 24px -4px hsl(var(--shadow-color) / 0.15)',
      },
      animation: {
        'fade-in': 'fade-in 0.3s ease-out forwards',
        'slide-up': 'slide-up 0.4s ease-out forwards',
        'subtle-pulse': 'subtle-pulse 2s ease-in-out infinite',
      },
      transitionDuration: {
        '250': '250ms',
        '350': '350ms',
      },
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
