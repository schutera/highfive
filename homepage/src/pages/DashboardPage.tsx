import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import MapView from '../components/MapView';
import ModulePanel from '../components/ModulePanel';
import { api, Module } from '../services/api';

export default function DashboardPage() {
  const [modules, setModules] = useState<Module[]>([]);
  const [visibleModules, setVisibleModules] = useState<Module[]>([]);
  const [selectedModule, setSelectedModule] = useState<Module | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadModules();
  }, []);

  const loadModules = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getAllModules();
      setModules(data);
    } catch (err) {
      setError('Failed to load modules. Make sure the backend is running.');
      console.error('Error loading modules:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow-md px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-2xl font-bold text-amber-600 hover:text-amber-700">
            🙌 HighFive
          </Link>
          <span className="text-gray-400">|</span>
          <h1 className="text-xl font-semibold text-gray-800">Dashboard</h1>
        </div>
        
        <div className="flex items-center gap-4">
          {loading ? (
            <div className="text-sm text-gray-600">Loading...</div>
          ) : error ? (
            <div className="text-sm text-red-600">{error}</div>
          ) : (
            <div className="text-sm text-gray-600">
              <span className="inline-block w-2 h-2 bg-green-500 rounded-full mr-2"></span>
              {modules.filter(m => m.status === 'online').length} / {modules.length} Modules Online
            </div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Error State - Backend Down */}
        {error && (
          <div className="flex-1 flex items-center justify-center bg-gradient-to-br from-amber-50 to-orange-50 p-8">
            <div className="max-w-md text-center">
              {/* Bee Animation */}
              <div className="mb-8 animate-bounce">
                <div className="text-8xl">🐝</div>
              </div>
              
              {/* Error Message */}
              <h2 className="text-3xl font-bold text-gray-800 mb-4">
                It's not you, it's us!
              </h2>
              <p className="text-sm text-gray-500 mb-8">
                Our worker bees are already on it.
              </p>
              
              {/* Retry Button */}
              <button
                onClick={loadModules}
                className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-lg shadow-lg transition-colors flex items-center gap-2 mx-auto"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Try Again
              </button>
              
              {/* Technical Details */}
              <div className="mt-8 p-4 bg-white/60 rounded-lg border border-amber-200">
                <p className="text-xs text-gray-500 font-mono">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Map Section */}
        {!error && (
          <div className="flex-1 relative">
            {!loading && (
              <MapView 
                modules={modules} 
                selectedModule={selectedModule}
                onModuleSelect={setSelectedModule}
                onVisibleModulesChange={setVisibleModules}
              />
            )}
          </div>
        )}

        {/* Right Panel - Module Details */}
        {!error && selectedModule && (
          <div className="w-80 bg-white shadow-2xl overflow-y-auto">
            <ModulePanel 
              module={selectedModule} 
              onClose={() => setSelectedModule(null)}
              onError={(errorMsg) => {
                setError(errorMsg);
                setSelectedModule(null);
              }}
            />
          </div>
        )}
      </div>

      {/* Floating Module List Window */}
      {!loading && !error && visibleModules.length > 0 && (
        <div className="absolute bottom-8 left-8 w-80 bg-white rounded-xl shadow-2xl z-[1000]">
          <div className="p-4">
            <h2 className="text-lg font-bold text-amber-600 mb-3">Hive Modules</h2>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {visibleModules.map((module) => (
                <button
                  key={module.id}
                  onClick={() => setSelectedModule(module)}
                  className={`w-full text-left p-3 rounded-lg transition-colors border ${
                    selectedModule?.id === module.id
                      ? 'bg-amber-50 border-amber-400'
                      : 'bg-gray-50 hover:bg-amber-50 border-gray-200 hover:border-amber-300'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-gray-900 text-sm">{module.name}</h3>
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${
                        module.status === 'online' ? 'bg-green-500' : 'bg-gray-400'
                      }`}
                    />
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
