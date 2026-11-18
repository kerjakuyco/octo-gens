import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/assistant.css";
import "./styles/ticket.css";
import "./styles/market.css";
import "./styles/pages.css";

const root = document.getElementById("root");
if (!root) throw new Error("The page is missing its #root element.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
