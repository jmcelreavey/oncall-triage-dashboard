import net from 'net';
import { spawn } from 'child_process';

function isPortOpen(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(800);
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host, () => {
      socket.end();
      resolve(true);
    });
  });
}

async function main() {
  const webUrl = process.env.OPENCODE_WEB_URL;
  if (!webUrl) return;
  let url;
  try {
    url = new URL(webUrl);
  } catch {
    return;
  }

  const host = url.hostname || '127.0.0.1';
  const port = Number(url.port || 4096);
  if (await isPortOpen(host, port)) return;

  const bin = process.env.OPENCODE_BIN || 'opencode';
  const args = ['serve', '--port', String(port), '--hostname', host];

  const child = spawn(bin, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

main().catch(() => undefined);
