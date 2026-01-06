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
  const [mobileListExpanded, setMobileListExpanded] = useState(false);

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

  // Close mobile list when module is selected
  const handleModuleSelect = (module: Module) => {
    setSelectedModule(module);
    setMobileListExpanded(false);
  };

  return (
    <div className="h-[100dvh] flex flex-col bg-gray-100 overflow-hidden">
      {/* Header - Compact on mobile */}
      <header className="bg-white shadow-md px-3 md:px-6 py-2 md:py-4 flex items-center justify-between shrink-0 z-20">
        <div className="flex items-center gap-2 md:gap-4">
          <Link to="/" className="text-lg md:text-2xl font-bold text-amber-600 hover:text-amber-700 flex items-center gap-1">
            <span className="text-xl md:text-2xl">🙌</span>
            <span className="inline">HighFive</span>
          </Link>
          <span className="text-gray-300 hidden md:inline">|</span>
          <h1 className="hidden md:block text-xl font-semibold text-gray-800">Dashboard</h1>
        </div>
        
        <div className="flex items-center gap-2 md:gap-4">
          {loading ? (
            <div className="text-xs md:text-sm text-gray-600 flex items-center gap-2">
              <div className="w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
              <span className="hidden sm:inline">Loading...</span>
            </div>
          ) : error ? (
            <div className="text-xs md:text-sm text-red-600 flex items-center gap-1">
              <span className="w-2 h-2 bg-red-500 rounded-full"></span>
              <span className="hidden sm:inline">Error</span>
            </div>
          ) : (
            <div className="text-xs md:text-sm text-gray-600 flex items-center gap-1.5">
              <span className="w-2 h-2 bg-green-500 rounded-full"></span>
              <span>{modules.filter(m => m.status === 'online').length}/{modules.length}</span>
              <span className="hidden sm:inline">Online</span>
            </div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        {/* Error State - Backend Down */}
        {error && (
          <div className="flex-1 flex items-center justify-center bg-gradient-to-br from-amber-50 to-orange-50 p-4 md:p-8">
            <div className="max-w-md text-center px-4">
              {/* Bee Animation */}
              <div className="mb-4 md:mb-8 animate-bounce">
                <div className="text-5xl md:text-8xl">🐝</div>
              </div>
              
              {/* Error Message */}
              <h2 className="text-xl md:text-3xl font-bold text-gray-800 mb-2 md:mb-4">
                It's not you, it's us!
              </h2>
              <p className="text-xs md:text-sm text-gray-500 mb-4 md:mb-8">
                Our worker bees are already on it.
              </p>
              
              {/* Retry Button */}
              <button
                onClick={loadModules}
                className="px-5 py-2.5 md:px-6 md:py-3 bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white text-sm md:text-base font-semibold rounded-lg shadow-lg transition-colors flex items-center gap-2 mx-auto min-h-[44px]"
              >
                <svg className="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Try Again
              </button>
              
              {/* Technical Details */}
              <div className="mt-4 md:mt-8 p-3 md:p-4 bg-white/60 rounded-lg border border-amber-200">
                <p className="text-xs text-gray-500 font-mono break-words">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Map Section - Full viewport on mobile */}
        {!error && (
          <div className="flex-1 relative">
            {!loading && (
              <MapView 
                modules={modules} 
                selectedModule={selectedModule}
                onModuleSelect={handleModuleSelect}
                onVisibleModulesChange={setVisibleModules}
              />
            )}
            
            {/* Loading overlay */}
            {loading && (
              <div className="absolute inset-0 bg-gray-100 flex items-center justify-center">
                <div className="text-center">
                  <div className="w-10 h-10 border-4 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
                  <p className="text-gray-600 text-sm">Loading map...</p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Desktop: Right Panel - Module Details */}
        {!error && selectedModule && (
          <div className="hidden md:flex w-80 lg:w-96 bg-white shadow-xl overflow-hidden flex-col border-l border-gray-200">
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

      {/* Mobile: Module Detail Panel - Full screen slide-up */}
      {!error && selectedModule && (
        <div 
          className="fixed inset-0 z-[1000] md:hidden"
          onClick={() => setSelectedModule(null)}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40" />
          
          {/* Panel - Full screen on mobile */}
          <div 
            className="absolute inset-0 bg-white flex flex-col animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Mobile header with back button */}
            <div className="flex items-center gap-3 px-4 py-3 border-b bg-white shrink-0 safe-area-top">
              <button
                onClick={() => setSelectedModule(null)}
                className="w-10 h-10 flex items-center justify-center hover:bg-gray-100 active:bg-gray-200 rounded-full transition-colors -ml-2"
              >
                <svg className="w-6 h-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <span className="font-semibold text-gray-900">Module Details</span>
            </div>
            
            {/* Panel content - full height scrollable */}
            <div className="flex-1 overflow-y-auto overscroll-contain">
              <ModulePanel 
                module={selectedModule} 
                onClose={() => setSelectedModule(null)}
                onError={(errorMsg) => {
                  setError(errorMsg);
                  setSelectedModule(null);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Desktop: Floating Module List */}
      {!loading && !error && visibleModules.length > 0 && (
        <div className="hidden md:flex absolute bottom-8 left-8 w-80 bg-white rounded-xl shadow-2xl z-[999] max-h-[400px] flex-col">
          <div className="p-4 border-b shrink-0">
            <h2 className="text-lg font-bold text-amber-600">Hive Modules</h2>
            <p className="text-xs text-gray-500 mt-0.5">{visibleModules.length} modules in view</p>
          </div>
          <div className="overflow-y-auto flex-1 p-4">
            <div className="space-y-2">
              {visibleModules.map((module) => (
                <button
                  key={module.id}
                  onClick={() => setSelectedModule(module)}
                  className={`w-full text-left p-3 rounded-lg transition-all border ${
                    selectedModule?.id === module.id
                      ? 'bg-amber-50 border-amber-400 shadow-sm'
                      : 'bg-gray-50 hover:bg-amber-50 border-gray-200 hover:border-amber-300'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-gray-900 truncate">{module.name}</h3>
                    <span
                      className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ml-2 ${
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

      {/* Mobile: Bottom Sheet Module List */}
      {!loading && !error && visibleModules.length > 0 && !selectedModule && (
        <div className="md:hidden absolute bottom-0 left-0 right-0 z-[999]">
          {/* Collapsed state - just a pill */}
          {!mobileListExpanded && (
            <div className="p-3 pb-safe-bottom">
              <button
                onClick={() => setMobileListExpanded(true)}
                className="w-full bg-white rounded-xl shadow-lg p-3 flex items-center justify-between active:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center">
                    <span className="text-lg">🐝</span>
                  </div>
                  <div className="text-left">
                    <div className="font-semibold text-gray-900 text-sm">Hive Modules</div>
                    <div className="text-xs text-gray-500">{visibleModules.length} in view • Tap to expand</div>
                  </div>
                </div>
                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                </svg>
              </button>
            </div>
          )}

          {/* Expanded state - full list */}
          {mobileListExpanded && (
            <div 
              className="fixed inset-0 z-50"
              onClick={() => setMobileListExpanded(false)}
            >
              {/* Backdrop */}
              <div className="absolute inset-0 bg-black/30" />
              
              {/* Bottom sheet */}
              <div 
                className="absolute inset-x-0 bottom-0 bg-white rounded-t-2xl shadow-2xl max-h-[70vh] flex flex-col animate-slide-up"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Drag handle */}
                <div className="flex justify-center py-2 shrink-0">
                  <div className="w-10 h-1 bg-gray-300 rounded-full"></div>
                </div>
                
                {/* Header */}
                <div className="flex justify-between items-center px-4 pb-3 border-b shrink-0">
                  <div>
                    <h2 className="font-bold text-gray-900">Hive Modules</h2>
                    <p className="text-xs text-gray-500">{visibleModules.length} modules in view</p>
                  </div>
                  <button
                    onClick={() => setMobileListExpanded(false)}
                    className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 active:bg-gray-200 rounded-full"
                  >
                    <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>
                
                {/* Module list */}
                <div className="overflow-y-auto overscroll-contain flex-1 p-4 pb-safe-bottom">
                  <div className="space-y-2">
                    {visibleModules.map((module) => (
                      <button
                        key={module.id}
                        onClick={() => handleModuleSelect(module)}
                        className={`w-full text-left p-3 rounded-xl transition-all border min-h-[56px] flex items-center ${
                          selectedModule?.id === module.id
                            ? 'bg-amber-50 border-amber-400'
                            : 'bg-gray-50 active:bg-amber-50 border-gray-200'
                        }`}
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                            module.status === 'online' ? 'bg-green-100' : 'bg-gray-200'
                          }`}>
                            <span className="text-lg">🐝</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold text-gray-900 truncate">{module.name}</h3>
                            <p className={`text-xs ${module.status === 'online' ? 'text-green-600' : 'text-gray-500'}`}>
                              {module.status === 'online' ? '● Online' : '○ Offline'}
                            </p>
                          </div>
                          <svg className="w-5 h-5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
