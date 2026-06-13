import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import "./styles.css";

const root = document.querySelector("#root");
if (!root) throw new Error("yaca Web root is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
