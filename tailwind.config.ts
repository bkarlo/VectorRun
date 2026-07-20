import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        forest: {
          50: "#f3f6f2",
          100: "#e3ebe0",
          200: "#c5d6bf",
          300: "#9bb892",
          400: "#729966",
          500: "#547b49",
          600: "#416239",
          700: "#344e2e",
          800: "#2b3f27",
          900: "#243522",
          950: "#121c11",
        },
        moss: {
          400: "#8a9e5b",
          500: "#6b7f3f",
          600: "#546432",
        },
        bark: {
          400: "#a67c52",
          500: "#8b6340",
          600: "#6f4e34",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
