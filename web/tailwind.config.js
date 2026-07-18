/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  safelist: [{ pattern: /(bg|text|border)-sev-(critical|warning|resolved|info|neutral)/ }],
  theme: {
    extend: {
      colors: {
        sev: {
          critical: "#e94560",
          warning: "#f5a524",
          resolved: "#4ade80",
          info: "#7dd3fc",
          neutral: "#94a3b8",
        },
      },
    },
  },
  plugins: [],
};
