import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        teal: {
          DEFAULT: "#00C9A7",
          50: "#E6FAF5",
          100: "#B2F0E3",
          200: "#80E6D1",
          300: "#4DDCBF",
          400: "#1AD2AD",
          500: "#00C9A7",
          600: "#00A88A",
          700: "#00876E",
          800: "#006652",
          900: "#004536",
        },
        navy: {
          DEFAULT: "#1A1A2E",
          50: "#F7F8FA",
          100: "#E5E7EB",
          200: "#D1D5DB",
          700: "#2D2D44",
          800: "#1A1A2E",
          900: "#0F0F1A",
        },
      },
    },
  },
  plugins: [],
};
export default config;
