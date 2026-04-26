import React from 'react';
import ReactDOM from 'react-dom/client';
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
