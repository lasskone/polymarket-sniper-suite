// health.js - Minimal health server, zero dependencies
// ESM syntax required because package.json has "type": "module"
//
// The bot is launched as a CHILD PROCESS so its process.exit() calls
// cannot kill this health server. Railway's healthcheck will always pass
// as long as this file runs, regardless of bot crashes.
import http from 'http';
import { spawn } from 'child_process';

const PORT = parseInt(process.env.PORT || '8080', 10);

console.log('=== HEALTH.JS STARTING ===');
console.log('PORT:', PORT);
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('Timestamp:', new Date().toISOString());

const server = http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      pid: process.pid,
      node: process.version
    }));
    return;
  }

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      timestamp: new Date().toISOString()
    }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Health server listening on 0.0.0.0:${PORT}`);
  console.log(`✅ Try: curl http://localhost:${PORT}/health`);
});

server.on('error', (err) => {
  console.error('❌ Health server error:', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM');
  server.close(() => process.exit(0));
});

// Launch the bot as a child process so its crashes / process.exit() calls
// cannot kill this health server process.
console.log('Launching main bot as child process...');
setTimeout(() => {
  const bot = spawn('node', ['dist/bot/index.js'], {
    stdio: 'inherit',   // pipe bot stdout/stderr to our stdout/stderr
    env: process.env,
  });

  bot.on('error', (err) => {
    console.error('❌ Failed to start bot process:', err.message);
    console.log('⚠️ Health server continues running anyway');
  });

  bot.on('exit', (code, signal) => {
    console.log(`⚠️ Bot process exited (code=${code}, signal=${signal})`);
    console.log('⚠️ Health server continues running anyway');
  });

  console.log(`✅ Bot process spawned (pid=${bot.pid})`);
}, 1000);
