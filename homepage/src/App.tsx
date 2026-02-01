import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import './style.css';
import HomePage from './pages/HomePage';
import DashboardPage from './pages/DashboardPage';
import WebInstaller from './pages/WebInstaller';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/web-installer" element={<WebInstaller />} />
      </Routes>
    </Router>
  );
}

export default App;
