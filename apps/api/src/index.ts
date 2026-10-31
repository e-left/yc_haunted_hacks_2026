import express from "express";
import type { HealthResponse } from "@lild/contracts";

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.get("/health/live", (_req, res) => {
  const body: HealthResponse = { status: "ok" };
  res.json(body);
});

app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});
