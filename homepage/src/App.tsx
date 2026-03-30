import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import './style.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LanguageProvider } from './i18n/LanguageContext';
import HomePage from './pages/HomePage';
import DashboardPage from './pages/DashboardPage';
import SetupWizard from './pages/SetupWizard';
import HiveModule from './pages/HiveModule';
import AssemblyGuide from './pages/AssemblyGuide';
import AdminPage from './pages/AdminPage';

function App() {
  return (
    <ErrorBoundary>
      <LanguageProvider>
      <Router>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/setup" element={<SetupWizard />} />
          <Route path="/hive-module" element={<HiveModule />} />
          <Route path="/assembly" element={<AssemblyGuide />} />
          <Route path="/admin" element={<AdminPage />} />
          {/* Redirect old routes */}
          <Route path="/web-installer" element={<Navigate to="/setup" replace />} />
          <Route path="/setup-guide" element={<Navigate to="/setup" replace />} />
          <Route path="/parts-list" element={<Navigate to="/hive-module" replace />} />
        </Routes>
      </Router>
      </LanguageProvider>
    </ErrorBoundary>
  );
}

export default App;
