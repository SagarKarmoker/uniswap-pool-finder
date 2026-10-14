/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.js"],
  theme: {
    extend: {
      colors: {
        ink: "#0b1220",
        panel: "#111827",
        brand: { 400: "#34d399", 500: "#10b981", 600: "#059669" },
        accent: "#22d3ee",
      },
    },
  },
  plugins: [],
};
