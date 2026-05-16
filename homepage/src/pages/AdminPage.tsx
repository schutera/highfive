import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, ImageUpload } from '../services/api';
import type { Module } from '@highfive/contracts';
import RenameModuleModal from '../components/RenameModuleModal';
import { hasPlausibleLocation } from '../lib/location';

const SESSION_KEY = 'highfive_admin_auth';

function LoginGate({ onAuth }: { onAuth: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(false);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/health`, {
        headers: { 'X-API-Key': password },
      });
      if (res.ok) {
        sessionStorage.setItem(SESSION_KEY, password);
        onAuth();
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl shadow-lg border border-gray-200 p-8 w-full max-w-sm"
      >
        <div className="text-center mb-6">
          <div className="text-4xl mb-2">🔒</div>
          <h1 className="text-xl font-bold text-gray-900">Admin Access</h1>
          <p className="text-sm text-gray-500 mt-1">Enter the API key to continue</p>
        </div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="API key"
          className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none mb-3"
          autoFocus
        />
        {error && <p className="text-red-600 text-xs mb-3">Invalid API key. Try again.</p>}
        <button
          type="submit"
          className="w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold py-2.5 rounded-lg transition-colors text-sm"
        >
          Sign in
        </button>
        <Link to="/" className="block text-center text-xs text-gray-400 hover:text-gray-600 mt-4">
          Back to Home
        </Link>
      </form>
    </div>
  );
}

export default function AdminPage() {
  const [authed, setAuthed] = useState(() => !!sessionStorage.getItem(SESSION_KEY));
  const [modules, setModules] = useState<Module[]>([]);
  const [images, setImages] = useState<ImageUpload[]>([]);
  const [selectedModule, setSelectedModule] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<ImageUpload | null>(null);
  // Module being renamed (null = no modal open). See ADR-011 / #93.
  const [renameTarget, setRenameTarget] = useState<Module | null>(null);

  useEffect(() => {
    if (authed) loadModules();
  }, [authed]);

  // Close lightbox on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxImage(null);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    if (authed) loadImages();
  }, [selectedModule, authed]);

  if (!authed) {
    return <LoginGate onAuth={() => setAuthed(true)} />;
  }

  const loadModules = async () => {
    try {
      const data = await api.getAllModules();
      setModules(data);
    } catch (err) {
      console.error('Failed to load modules:', err);
    }
  };

  const loadImages = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getImages(selectedModule || undefined);
      setImages(data);
    } catch (err) {
      setError('Failed to load images. Is the image service running?');
      console.error('Failed to load images:', err);
    } finally {
      setLoading(false);
    }
  };

  // Coalesces the operator-settable override over the firmware-reported
  // name. Falls back to the bare MAC if the module is unknown to this
  // page (e.g. an image label for a module that's since been deleted).
  // See ADR-011 / issue #93.
  const getModuleLabel = (moduleId: string) => {
    const mod = modules.find((m) => m.id === moduleId);
    if (!mod) return moduleId;
    return mod.displayName ?? mod.name;
  };

  const handleDeleteModule = async (mod: Module) => {
    const label = mod.displayName ?? mod.name;
    if (!confirm(`Delete module "${label}" (${mod.id}) and all its data?`)) return;
    try {
      await api.deleteModule(mod.id);
      setModules((prev) => prev.filter((m) => m.id !== mod.id));
      if (selectedModule === mod.id) setSelectedModule('');
    } catch (err) {
      console.error('Failed to delete module:', err);
    }
  };

  const handleDelete = async (img: ImageUpload) => {
    if (!confirm(`Delete ${img.filename}?`)) return;
    try {
      await api.deleteImage(img.filename);
      setImages((prev) => prev.filter((i) => i.filename !== img.filename));
      if (lightboxImage?.filename === img.filename) setLightboxImage(null);
    } catch (err) {
      console.error('Failed to delete image:', err);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  };

  // Relative time + color for liveness signals (lastSeenAt / heartbeat).
  // Green <2h, amber <24h, red older / never.
  const formatRelative = (iso: string | null | undefined): { text: string; color: string } => {
    if (!iso) return { text: '—', color: 'text-gray-300' };
    const ageMs = Date.now() - new Date(iso).getTime();
    if (isNaN(ageMs)) return { text: '—', color: 'text-gray-300' };
    const sec = Math.floor(ageMs / 1000);
    let text: string;
    if (sec < 60) text = `${sec}s ago`;
    else if (sec < 3600) text = `${Math.floor(sec / 60)}m ago`;
    else if (sec < 86400) text = `${Math.floor(sec / 3600)}h ago`;
    else text = `${Math.floor(sec / 86400)}d ago`;
    const color =
      ageMs < 2 * 3600 * 1000
        ? 'text-green-700'
        : ageMs < 24 * 3600 * 1000
          ? 'text-amber-600'
          : 'text-red-600';
    return { text, color };
  };

  const formatUptime = (ms: number | null | undefined): string => {
    if (ms == null) return '—';
    const sec = Math.floor(ms / 1000);
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
    return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              to="/"
              className="text-2xl font-bold text-amber-600 hover:text-amber-700 flex items-center gap-2"
            >
              <span className="text-2xl">🙌</span>
              <span>HighFive</span>
            </Link>
            <span className="text-gray-300">|</span>
            <h1 className="text-xl font-semibold text-gray-800">Admin &mdash; Image Inspector</h1>
          </div>
          <div className="flex items-center gap-4">
            <Link
              to="/dashboard"
              className="text-sm text-amber-600 hover:text-amber-700 font-medium"
            >
              Dashboard
            </Link>
            <button
              onClick={() => {
                sessionStorage.removeItem(SESSION_KEY);
                setAuthed(false);
              }}
              className="text-sm text-gray-400 hover:text-gray-600 font-medium"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Module Overview */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 mb-8 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-800">Modules ({modules.length})</h2>
          </div>
          {modules.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">ID</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Last Seen</th>
                    <th className="px-4 py-3">Telemetry</th>
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Location</th>
                    <th className="px-4 py-3">Images</th>
                    <th className="px-4 py-3">First Online</th>
                    <th className="px-4 py-3">Last Image</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {modules.map((m) => (
                    <tr
                      key={m.id}
                      className={`hover:bg-amber-50/50 cursor-pointer transition-colors ${selectedModule === m.id ? 'bg-amber-50' : ''}`}
                      onClick={() => setSelectedModule(selectedModule === m.id ? '' : m.id)}
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {m.displayName ?? m.name}
                        {m.displayName && (
                          <span
                            className="ml-2 text-[10px] font-normal text-gray-400"
                            title={`Firmware-reported name: ${m.name}`}
                          >
                            ({m.name})
                          </span>
                        )}
                        {/* "Location pending" pill — PR II / issue #89.
                            Lets the operator spot modules that registered
                            at the (0,0) sentinel before the heartbeat-side
                            recovery has caught up.

                            Hardcoded English, not piped through i18n,
                            because AdminPage is entirely English today
                            (operator-facing, no LanguageContext consumer
                            anywhere in this file). When a future PR
                            wires AdminPage to i18n, this becomes a
                            `t('dashboard.locationPending')` call — both
                            translation strings are already in place. */}
                        {!hasPlausibleLocation(m.location) && (
                          <span
                            className="ml-2 inline-block px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wider bg-amber-100 text-amber-700"
                            title="Module registered without a usable geolocation fix; will recover on the next successful heartbeat retry."
                          >
                            Location pending
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs">{m.id}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 text-xs font-medium ${m.status === 'online' ? 'text-green-700' : 'text-gray-500'}`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${m.status === 'online' ? 'bg-green-500' : 'bg-gray-400'}`}
                          />
                          {m.status}
                        </span>
                      </td>
                      <td
                        className={`px-4 py-3 text-xs ${formatRelative(m.lastSeenAt).color}`}
                        title={m.lastSeenAt || 'never seen'}
                      >
                        {formatRelative(m.lastSeenAt).text}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">
                        {m.latestHeartbeat ? (
                          <div className="flex flex-col gap-0.5 leading-tight">
                            <span>📶 {m.latestHeartbeat.rssi ?? '—'} dBm</span>
                            <span className="text-gray-400 font-mono text-[10px]">
                              {m.latestHeartbeat.fwVersion ?? 'unknown'} · uptime{' '}
                              {formatUptime(m.latestHeartbeat.uptimeMs)} · heap{' '}
                              {m.latestHeartbeat.freeHeap
                                ? Math.floor(m.latestHeartbeat.freeHeap / 1024) + ' kB'
                                : '—'}
                            </span>
                          </div>
                        ) : (
                          <span className="text-gray-300">no heartbeat yet</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600 text-xs">
                        {m.email || <span className="text-gray-300">&mdash;</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs font-mono">
                        {m.location.lat.toFixed(4)}, {m.location.lng.toFixed(4)}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{m.imageCount}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {m.firstOnline || <span className="text-gray-300">&mdash;</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {m.lastApiCall ? (
                          formatDate(m.lastApiCall)
                        ) : (
                          <span className="text-gray-300">&mdash;</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenameTarget(m);
                            }}
                            className="text-gray-400 hover:text-amber-600 transition-colors"
                            title="Rename module (sets display_name override)"
                            aria-label={`Rename module ${m.displayName ?? m.name}`}
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                              />
                            </svg>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteModule(m);
                            }}
                            className="text-red-400 hover:text-red-600 transition-colors"
                            title="Delete module"
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Image Filter & Stats */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-8">
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
              <label className="text-sm font-medium text-gray-700">Filter by module:</label>
              <select
                value={selectedModule}
                onChange={(e) => setSelectedModule(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none min-w-[200px]"
              >
                <option value="">All modules</option>
                {modules.map((m) => (
                  <option key={m.id} value={m.id}>
                    {(m.displayName ?? m.name) + ' (' + m.id + ')'}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-6 text-sm text-gray-600">
              <div>
                <span className="font-semibold text-gray-900">{images.length}</span> images
              </div>
              <div>
                <span className="font-semibold text-gray-900">{modules.length}</span> modules
              </div>
            </div>
          </div>
        </div>

        {/* Error State */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 mb-8 text-center">
            <p className="text-red-700 mb-3">{error}</p>
            <button
              onClick={loadImages}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <div className="w-10 h-10 border-4 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
              <p className="text-gray-500 text-sm">Loading images...</p>
            </div>
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && images.length === 0 && (
          <div className="text-center py-20">
            <div className="text-6xl mb-4">📷</div>
            <h2 className="text-xl font-semibold text-gray-700 mb-2">No images yet</h2>
            <p className="text-gray-500">
              {selectedModule
                ? 'This module has not uploaded any images yet.'
                : 'No modules have uploaded images yet.'}
            </p>
          </div>
        )}

        {/* Image Grid */}
        {!loading && !error && images.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {images.map((img, idx) => (
              <button
                key={`${img.filename}-${idx}`}
                onClick={() => setLightboxImage(img)}
                className="group bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md hover:border-amber-300 transition-all text-left"
              >
                <div className="aspect-square bg-gray-100 relative overflow-hidden">
                  <img
                    src={api.getImageUrl(img.filename)}
                    alt={img.filename}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    loading="lazy"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      target.style.display = 'none';
                      target.parentElement!.innerHTML =
                        '<div class="flex items-center justify-center w-full h-full text-gray-400 text-4xl">🖼️</div>';
                    }}
                  />
                  <div
                    className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(img);
                    }}
                  >
                    <span className="bg-red-500 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs shadow cursor-pointer">
                      <svg
                        className="w-3.5 h-3.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </span>
                  </div>
                </div>
                <div className="p-2.5">
                  <p className="text-xs font-medium text-amber-700 truncate">
                    {getModuleLabel(img.module_id)}
                  </p>
                  <p className="text-[10px] text-gray-400 mt-0.5">{formatDate(img.uploaded_at)}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>

      {/* Lightbox */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightboxImage(null)}
        >
          <div
            className="relative max-w-5xl max-h-[90vh] w-full flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={() => setLightboxImage(null)}
              className="absolute -top-10 right-0 text-white/80 hover:text-white text-sm font-medium"
            >
              Close (Esc)
            </button>

            {/* Image */}
            <div className="flex-1 flex items-center justify-center min-h-0">
              <img
                src={api.getImageUrl(lightboxImage.filename)}
                alt={lightboxImage.filename}
                className="max-w-full max-h-[80vh] object-contain rounded-lg"
              />
            </div>

            {/* Info bar */}
            <div className="mt-4 bg-white/10 backdrop-blur rounded-lg p-3 flex items-center justify-between text-sm text-white">
              <div>
                <span className="font-medium">{getModuleLabel(lightboxImage.module_id)}</span>
                <span className="text-white/60 mx-2">|</span>
                <span className="text-white/80">{lightboxImage.module_id}</span>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-white/60">{formatDate(lightboxImage.uploaded_at)}</span>
                <button
                  onClick={() => handleDelete(lightboxImage)}
                  className="px-3 py-1 bg-red-500/80 hover:bg-red-500 text-white text-xs font-medium rounded transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Rename modal — opens when a row's pencil icon is clicked. The
          modal carries the api call + admin-key prompt + 409-collision
          inline error; we just give it a Module and an `onSaved`
          callback to keep the local list in sync. See ADR-011. */}
      {renameTarget && (
        <RenameModuleModal
          module={renameTarget}
          onClose={() => setRenameTarget(null)}
          onSaved={(displayName) => {
            // Optimistic local update so the table reflects the new
            // label without a full /modules refetch. The next refresh
            // (e.g. on selectedModule change) will reconcile if the
            // server normalised the value differently.
            const id = renameTarget.id;
            setModules((prev) => prev.map((m) => (m.id === id ? { ...m, displayName } : m)));
          }}
        />
      )}
    </div>
  );
}
