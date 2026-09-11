import { createGateway } from './proxy.js';

const port = Number(process.env.PROXY_PORT || 8080);
const server = createGateway(process.env.API_TARGET || 'http://127.0.0.1:3000', process.env.FRONTEND_TARGET || 'http://127.0.0.1:3001');
server.listen(port, '127.0.0.1', () => console.log(`Frontend + relay at http://127.0.0.1:${port}. Set Express PUBLIC_URL to your public origin.`));
function stop() { server.closeAllConnections(); server.close(); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
