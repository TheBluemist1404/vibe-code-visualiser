import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { httpApi } from "./api/client";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App api={httpApi()} />
  </StrictMode>,
);
