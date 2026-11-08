import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { legacyRoute } from "./lib/legacyRoute";
import "./styles.css";

const legacyPath = legacyRoute(window.location.hash, window.location.origin);
if (legacyPath) {
  window.history.replaceState(null, "", legacyPath);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
