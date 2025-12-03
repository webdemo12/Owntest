import runApp from "./app.js";

// API-only mode for separate frontend/backend deployment
// No static file serving - frontend is deployed separately
export async function apiOnlySetup(app, _server) {
  // No setup needed - just run the API routes
  // CORS headers will be handled by the routes/app middleware if needed
  console.log("API-only mode: Backend serving API requests only");
}

(async () => {
  await runApp(apiOnlySetup);
})();
