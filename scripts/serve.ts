/**
 * Serves the built site on http://localhost:8000 (set PORT for another port).
 * See lib/site-server.ts for what it serves.
 */
import { failureText } from './lib/build-error.ts';
import { startSiteServer } from './lib/site-server.ts';

try {
  const { port } = await startSiteServer(Number(process.env['PORT']) || 8000);
  console.log(`Test page: http://localhost:${port}   (press Ctrl+C to stop)`);
} catch (err) {
  console.error(failureText(err));
  process.exitCode = 1;
}
