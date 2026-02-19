import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, Module } from '../services/api';

export default function WebInstaller() {
  const [modules, setModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Firmware States
  const [firmwareUrl, setFirmwareUrl] = useState<string>('/firmware.bin');
  const [firmwareVersion, setFirmwareVersion] = useState<string>('Loading...');
  const [firmwareLoading, setFirmwareLoading] = useState(true);


  useEffect(() => {
    loadModules();
    loadLatestFirmware();
    // ESP Web Tools Script laden
    const script = document.createElement("script");
    script.type = "module";
    script.src = "https://unpkg.com/esp-web-tools@9/dist/web/install-button.js";
    document.body.appendChild(script);
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

  const loadLatestFirmware = async () => {
    try {
      setFirmwareLoading(true);
      
      // GitHub API: Latest Release abrufen
      const response = await fetch(
        'https://api.github.com/repos/schutera/highfive/releases/latest'
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch latest release');
      }
      
      const releaseData = await response.json();
      
      // Finde firmware.bin Asset
      const firmwareAsset = releaseData.assets.find(
        (asset: any) => asset.name === 'firmware.bin'
      );
      
      if (firmwareAsset) {
        setFirmwareUrl(firmwareAsset.browser_download_url);
        setFirmwareVersion(releaseData.tag_name || releaseData.name);
        console.log('Firmware loaded from GitHub:', releaseData.tag_name);
      } else {
        console.log('No firmware.bin in release, using local');
        setFirmwareUrl('/firmware.bin');
        setFirmwareVersion('Local');
      }
    } catch (err) {
      console.error('Error loading firmware:', err);
      // Fallback auf lokale Datei
      setFirmwareUrl('/firmware.bin');
      setFirmwareVersion('Local (Fallback)');
    } finally {
      setFirmwareLoading(false);
    }
  };


  return (
    <div className="h-[100dvh] flex flex-col bg-gray-100 overflow-hidden">
      {/* Header */}
      <header className="bg-white shadow-md px-3 md:px-6 py-2 md:py-4 flex items-center justify-between shrink-0 z-20">
        <div className="flex items-center gap-2 md:gap-4">
          <Link
            to="/"
            className="text-lg md:text-2xl font-bold text-amber-600 hover:text-amber-700 flex items-center gap-1"
          >
            <span className="text-xl md:text-2xl">🙌</span>
            <span className="inline">HighFive</span>
          </Link>
          <span className="text-gray-300 hidden md:inline">|</span>
          <h1 className="hidden md:block text-xl font-semibold text-gray-800">
            Web Installer
          </h1>
        </div>
      </header>

      {/* CONTENT */}
      <main className="flex-1 flex flex-col items-center justify-center px-4">
        <h2 className="text-2xl font-bold mb-4">ESP32 Firmware Installer</h2>

        <p className="mb-6 text-center max-w-md text-gray-700">
          Connect your ESP32 via USB and click the button
          (Chrome or Edge required)
        </p>

      {/* Firmware Info Box */}
      <div className="mb-6 bg-blue-50 border-2 border-blue-200 rounded-lg p-4 max-w-md mx-auto">
        <div className="flex items-center justify-between mb-2">
          <span className="text-gray-700 font-medium">Firmware Version:</span>
          {firmwareLoading ? (
            <span className="text-gray-500">Laden...</span>
          ) : (
            <span className="text-blue-600 font-bold">{firmwareVersion}</span>
          )}
        </div>
        <div className="text-xs text-gray-500">
          {firmwareUrl.startsWith('http') 
            ? 'Von GitHub Release geladen' 
            : 'Lokale Datei (Fallback)'}
        </div>
      </div>


        {/* ESP WEB INSTALLER BUTTON */}
        <esp-web-install-button manifest="/manifest.json">
          <button className="bg-blue-500 hover:bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold transition-colors">
            Firmware installieren
          </button>
        </esp-web-install-button>

        {/* Link zur Anleitung */}
        <div className="mt-8 text-center">
          <p className="text-gray-600 mb-3">
            Firmware installed successfully? 
          </p>
          <Link
            to="/setup-guide"
            className="inline-block bg-green-500 hover:bg-green-600 text-white px-6 py-3 rounded-lg font-semibold transition-colors shadow-lg"
          >
            → Go to Setup Guide
          </Link>
        </div>


        {error && (
          <p className="mt-4 text-red-600">{error}</p>
        )}
      </main>
    </div>
  );
}
