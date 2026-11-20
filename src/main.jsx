import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

const rootElement = document.getElementById("root");

function renderStartupError(title, message) {
  rootElement.replaceChildren();

  const container = document.createElement("div");
  container.style.cssText = "min-height:100vh;background:#030303;color:#f4f4f4;font-family:Arial,sans-serif;padding:24px";

  const heading = document.createElement("h1");
  heading.style.cssText = "margin:0 0 12px;font-size:28px";
  heading.textContent = "ChainSentra Monitor";

  const label = document.createElement("p");
  label.style.color = "#f25555";
  label.textContent = title;

  const details = document.createElement("pre");
  details.style.cssText = "white-space:pre-wrap;color:#9ca3af";
  details.textContent = message || "Unknown error";

  container.append(heading, label, details);
  rootElement.append(container);
}

window.addEventListener("error", (event) => {
  renderStartupError("React startup error", event.message);
});

try {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} catch (error) {
  renderStartupError("React render error", error.message);
}
