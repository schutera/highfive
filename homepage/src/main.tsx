import React from 'react';
import ReactDOM from 'react-dom/client';
import './style.css';
// Side-effect import: api-key-validator's top-level call runs at module
// load. We import it from main.tsx (the entry chunk) so the throw fires
// on the FIRST page load, regardless of which route React Router shows.
// Lazy-loading the validator with api.ts would let a misconfigured
// production bundle render the home page cleanly and only fast-fail on
// /dashboard or /admin — defeating the "fast-fail at first load"
// guarantee. The cost is ~30 bytes in the entry chunk + one inlined
// throw site; cheap insurance.
import './services/api-key-validator';
import App from './App';
// NOTE: leaflet's stylesheet is now imported inside MapView so it only
// loads with the dashboard's lazy chunk — it doesn't need to be paid for
// on the homepage.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
