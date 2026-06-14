import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initLogging } from "./lib/logger";
import "./styles/globals.css";
import "./styles/hljs-theme.css";

initLogging();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
