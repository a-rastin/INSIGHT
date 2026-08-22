import ReactDOM from "react-dom/client";
import type { HealthResponse } from "@insight/contracts";

import "./styles.css";

const health: HealthResponse = { schemaVersion: "1", status: "ok" };

ReactDOM.createRoot(document.getElementById("root")!).render(
  <main>
    <p className="eyebrow">Decision support workspace</p>
    <h1>INSIGHT</h1>
    <p>Web runtime ready: {health.status}.</p>
  </main>,
);
