import { useEffect, useState } from 'react';
import { api, ModuleDetail } from '../services/api';
import { BEE_TYPES } from '../types';
<<<<<<< HEAD


=======
>>>>>>> main
interface ModulePanelProps {
  module: { id: string; name: string; status: 'online' | 'offline' };
  onClose: () => void;
  onError: (error: string) => void;
}

export default function ModulePanel({ module, onClose, onError }: ModulePanelProps) {
  const [moduleDetail, setModuleDetail] = useState<ModuleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadModuleDetail();
  }, [module.id]);

  const loadModuleDetail = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getModuleById(module.id);
      setModuleDetail(data);
    } catch (err) {
      const errorMsg = 'Failed to load module details';
      setError(errorMsg);
      console.error('Error loading module details:', err);
      onError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-600">Loading...</div>
      </div>
    );
  }

  if (error || !moduleDetail) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-red-600">{error || 'Module not found'}</div>
      </div>
    );
  }

  const isOnline = moduleDetail.status === 'online';
  const lastApiCall = new Date(moduleDetail.lastApiCall);
  const batteryLevel = Math.round(moduleDetail.batteryLevel);
  const batteryColor = batteryLevel > 50 ? 'text-green-500' : batteryLevel > 20 ? 'text-amber-500' : 'text-red-500';

  const formattedTime = lastApiCall.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  
  // Calculate totals per bee type and get latest progress
  const beeTypeSummaries = BEE_TYPES.map(beeType => {
    const nestsForType = moduleDetail.nests.filter(n => n.beeType === beeType.key);
    const totalHatched = nestsForType.reduce((sum, nest) => {
      const latestData = nest.dailyProgress[nest.dailyProgress.length - 1];
      return sum + (latestData?.hatched || 0);
    }, 0);
    
    return {
      ...beeType,
      nests: nestsForType.map(nest => {
        const latestData = nest.dailyProgress[nest.dailyProgress.length - 1];
        return {
          nestId: nest.nestId,
          sealed: latestData?.sealed || 0,
          hatched: latestData?.hatched || 0
        };
      }),
      totalHatched
    };
  });

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-gradient-to-r from-amber-500 to-orange-500 p-4 md:p-5 text-white shadow-lg relative">
        {/* Desktop close button - hidden on mobile since parent handles it */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-white/80 hover:text-white hover:bg-white/20 rounded-full p-1.5 transition-colors hidden md:flex items-center justify-center"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        
        <div className="pr-0 md:pr-8">
          <h2 className="text-xl md:text-2xl font-bold mb-2 md:mb-3">{moduleDetail.name}</h2>
          
          <div className="flex flex-wrap items-center gap-2 md:gap-3 mb-2">
            {/* Status Badge */}
            <div className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${isOnline ? 'bg-green-500/90' : 'bg-gray-500/90'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-white animate-pulse' : 'bg-white/70'}`} />
              {isOnline ? 'Online' : 'Offline'}
            </div>
            
            {/* Battery Badge */}
            <div className="inline-flex items-center gap-1.5 bg-white/20 rounded-full px-3 py-1 text-xs font-semibold">
              <svg className={`w-3.5 h-3.5 ${batteryColor}`} fill="currentColor" viewBox="0 0 24 24">
                <path d="M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4z"/>
              </svg>
              {batteryLevel}%
            </div>
          </div>
          
          <div className="text-amber-100/90 text-xs">
            <div>Last update: {formattedTime}</div>
<<<<<<< HEAD
            {/* <div>First online: {new Date(moduleDetail.firstOnline).getFullYear()}</div> */}
=======
>>>>>>> main
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Species Cards - Responsive grid on larger mobile, stack on small */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 gap-3 md:gap-4">
          {beeTypeSummaries.map((summary) => (
            <div key={summary.key}>
              {/* Summary Card */}
              <div 
                className="rounded-xl p-3 md:p-4 shadow-sm border-2 transition-transform active:scale-[0.98] md:active:scale-100"
                style={{ 
                  backgroundColor: summary.lightColor,
                  borderColor: summary.color 
                }}
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{summary.size}</div>
                    <div className="text-base md:text-lg font-bold" style={{ color: summary.color }}>{summary.name}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl md:text-3xl font-bold" style={{ color: summary.color }}>
                      {summary.totalHatched}
                    </div>
                    <div className="text-xs text-gray-500">hatches</div>
                  </div>
                </div>
                
                {/* Individual nest progress bars */}
                <div className="space-y-2 mt-3">
                  {summary.nests.map((nest, index) => (
                    <div key={nest.nestId}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-gray-600 font-medium">Nest {index + 1}</span>
                        <span className="text-xs font-bold" style={{ color: summary.color }}>
                          {nest.sealed}%
                        </span>
                      </div>
                      <div className="h-2 bg-white/60 rounded-full overflow-hidden shadow-inner">
                        <div 
                          className="h-full transition-all duration-500 rounded-full"
                          style={{ 
                            width: `${nest.sealed}%`,
                            backgroundColor: summary.color
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
