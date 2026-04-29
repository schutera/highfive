import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import os from 'os';

/**
 * Vite plugin that serves the machine's LAN IP at /__dev-api/lan-ip.
 * Used by the setup wizard to replace "localhost" in server URLs
 * before sending them to the ESP module (which can't reach localhost).
 */
function lanIpPlugin(): Plugin {
  return {
    name: 'lan-ip',
    configureServer(server) {
      server.middlewares.use('/__dev-api/lan-ip', (_req, res) => {
        const ip = getLocalIp();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ip }));
      });
    },
  };
}

function getLocalIp(): string {
  const nets = os.networkInterfaces();
  // Prefer common real adapter names (Wi-Fi, Ethernet, en0, wlan0, eth0)
  const preferredPatterns = /^(Wi-Fi|WiFi|Ethernet|en\d|wlan\d|eth\d)$/i;
  const allIps: { name: string; ip: string }[] = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (!net.internal && net.family === 'IPv4') {
        allIps.push({ name, ip: net.address });
      }
    }
  }

  // 1st choice: preferred adapter name
  const preferred = allIps.find((e) => preferredPatterns.test(e.name));
  if (preferred) return preferred.ip;

  // 2nd choice: common LAN ranges (192.168.x.x, 10.x.x.x)
  const lan = allIps.find((e) => e.ip.startsWith('192.168.') || e.ip.startsWith('10.'));
  if (lan) return lan.ip;

  return allIps[0]?.ip || 'localhost';
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), lanIpPlugin()],
  // Treat .bin and .FCStd files as binary assets so we can import them with
  // `?url` and Vite will emit them with content hashes.
  assetsInclude: ['**/*.bin', '**/*.FCStd'],
  server: {
    proxy: {
      // Proxy requests to the ESP module's config portal (bypasses CORS in dev)
      '/esp-api': {
        target: 'http://192.168.4.1',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/esp-api/, ''),
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Manual chunks: split heavy/cacheable libs into long-lived chunks so
        // they don't churn on every app deploy and the homepage can boot
        // without paying for leaflet on first paint.
        manualChunks: (id) => {
          // Vite's __vite__preload helper is a virtual module
          // (\0vite/preload-helper.js). When manualChunks doesn't claim it,
          // Rollup colocates it with whichever async chunk happens to use
          // it — in our case esptool. The entry then imports the helper
          // FROM esptool, dragging a modulepreload of esptool onto every
          // page. Pin the helper to the react chunk (always loaded) so
          // the entry never needs to reach into a feature chunk for it.
          if (id.includes('vite/preload-helper')) return 'react';

          if (!/[\\/]node_modules[\\/]/.test(id)) return;
          if (/[\\/]node_modules[\\/](leaflet|react-leaflet)[\\/]/.test(id)) {
            return 'leaflet';
          }
          if (/[\\/]node_modules[\\/]esptool-js[\\/]/.test(id)) {
            return 'esptool';
          }
          if (/[\\/]node_modules[\\/]react-router(-dom)?[\\/]/.test(id)) {
            return 'router';
          }
          if (/[\\/]node_modules[\\/](react|react-dom)[\\/]/.test(id)) {
            return 'react';
          }
        },
      },
    },
  },
});
