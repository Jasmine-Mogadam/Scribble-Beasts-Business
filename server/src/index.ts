import { createServer } from './app.js';
import { Rooms } from './lib/components/Room.js';

if (!process.env.SERVER_PORT) {
  throw new Error('Missing SERVER_PORT in environment variables');
}
const SERVER_PORT = Number(process.env.SERVER_PORT);

const server = createServer(SERVER_PORT, Rooms);
server.ready.then((port) => {
  console.log(`Server is running at http://0.0.0.0:${port}/`);
  console.log(
    `Ngnix is running at http://localhost:${process.env.NGINX_PORT}/`,
  );
});

// Graceful shutdown handler
function shutdownHandler(signal: string) {
  console.log(`Received signal ${signal}. Closing server...`);
  server.close().then(() => process.exit(0));
}

// Register signals for graceful shutdown
['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => shutdownHandler(signal));
});
