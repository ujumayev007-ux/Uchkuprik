// Run the compiled API and frontend from one service and one HTTP port.
// The backend reads platform variables first, then the ignored local .env.
process.env.SERVE_FRONTEND = 'true';
await import('../backend/dist/server.js');
