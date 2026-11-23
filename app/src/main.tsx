import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Tabs from "./Tabs";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Tabs />
  </StrictMode>,
);
