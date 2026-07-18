// Loaded here rather than in `app.ts`, so importing the app in a test never reads a local `.env`.
import "dotenv/config";
import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`Manufactum Voicebot backend is listening on port ${port}`);
});
