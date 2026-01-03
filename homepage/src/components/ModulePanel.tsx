import { useEffect, useState } from 'react';
import { api, ModuleDetail } from '../services/api';
import { BEE_TYPES } from '../types';
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
      <div className="bg-gradient-to-r from-amber-500 to-orange-500 p-5 text-white shadow-lg relative">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-white/80 hover:text-white hover:bg-white/20 rounded-full p-1.5 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        
        <div className="pr-8">
          <h2 className="text-2xl font-bold mb-3">{moduleDetail.name}</h2>
          
          <div className="flex items-center gap-3 mb-2">
            {/* Status Badge */}
            <div className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold ${isOnline ? 'bg-green-500/90' : 'bg-gray-500/90'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-white' : 'bg-white/70'}`} />
              {isOnline ? 'Online' : 'Offline'}
            </div>
            
            {/* Battery Badge */}
            <div className="inline-flex items-center gap-1.5 bg-white/20 rounded-md px-2.5 py-1 text-xs font-semibold">
              <svg className={`w-3.5 h-3.5 ${batteryColor}`} fill="currentColor" viewBox="0 0 24 24">
                <path d="M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4z"/>
              </svg>
              {batteryLevel}%
            </div>
          </div>
          
          <div className="text-amber-100/90 text-xs space-y-0.5">
            <div>Last update: {formattedTime}</div>
            <div>First online: {new Date(moduleDetail.firstOnline).getFullYear()}</div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Species Cards - Vertical Stack */}
        <div className="space-y-4">
          {beeTypeSummaries.map((summary) => (
            <div key={summary.key}>
              {/* Summary Card */}
              <div 
                className="rounded-lg p-3 shadow-sm border-2"
                style={{ 
                  backgroundColor: summary.lightColor,
                  borderColor: summary.color 
                }}
              >
                <div className="text-xs font-semibold mb-1 text-gray-700">{summary.size}</div>
                <div className="text-base font-bold mb-2" style={{ color: summary.color }}>{summary.name}</div>
                <div className="text-3xl font-bold mb-1" style={{ color: summary.color }}>
                  {summary.totalHatched}
                </div>
                <div className="text-xs text-gray-600 mb-2">Total Hatches</div>
                
                {/* Individual nest progress bars */}
                <div className="space-y-1">
                  {summary.nests.map((nest, index) => (
                    <div key={nest.nestId}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-gray-600">Nest {index + 1}</span>
                        <span className="text-xs font-semibold" style={{ color: summary.color }}>
                          {nest.sealed}%
                        </span>
                      </div>
                      <div className="h-1.5 bg-white/50 rounded-full overflow-hidden">
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
