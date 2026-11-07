/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#142421",
        paper: "#f3efe4",
        card: "#fffcf6",
        pine: "#1c6b60",
        brass: "#8a6430",
        line: "#ddd4c4",
      },
      fontFamily: {
        serif: ["Source Serif 4", "Georgia", "serif"],
        sans: ["Source Sans 3", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};
