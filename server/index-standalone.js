// Standalone backend server for separate hosting
import { createServer as createHttpServer } from "http";
import { app } from "./app.js";
import { registerRoutes } from "./routes.js";

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "0.0.0.0";

export default async function runStandaloneApp() {
  // Initialize routes and database
  await registerRoutes(app);

  const server = createHttpServer(app);

  server.listen(PORT, HOST, () => {
    console.log(`✅ M3 Matka Backend Server running at http://${HOST}:${PORT}`);
    console.log(`📡 Available routes: /api/*`);
    console.log(`🔐 CORS enabled for cross-origin requests`);
    console.log(`📝 Database connected: ${process.env.DATABASE_URL ? "✓" : "✗"}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`❌ Port ${PORT} is already in use`);
      process.exit(1);
    }
    throw err;
  });

  return server;
}

(async () => {
  await runStandaloneApp();
})();
