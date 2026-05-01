import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted Inter Variable (weight axis 100-900). Browser fetches
// only the unicode-ranges it actually needs based on the page's
// content, so EN+DE pull ~25 KB of woff2 even though several ranges
// are declared. Imported here (not from CSS) so Vite's module graph
// resolves the npm package and emits content-hashed assets.
import '@fontsource-variable/inter/wght.css';
import './style.css';
import App from './App';
// NOTE: leaflet's stylesheet is now imported inside MapView so it only
// loads with the dashboard's lazy chunk — it doesn't need to be paid for
// on the homepage.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
