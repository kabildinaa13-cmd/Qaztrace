/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#030303",
          925: "#070707",
          900: "#0b0b0b",
          850: "#101010",
          800: "#151515",
        },
        sentinel: {
          green: "#2fd16b",
          line: "#242424",
          muted: "#8b8b8b",
          danger: "#f25555",
          warning: "#d8a84e",
          blue: "#5c8fd8",
        },
      },
      boxShadow: {
        panel: "0 18px 44px rgba(0, 0, 0, 0.45)",
      },
    },
  },
  plugins: [],
};
