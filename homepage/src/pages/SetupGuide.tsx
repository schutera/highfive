import { Link } from 'react-router-dom';
import { useState } from 'react';

export default function SetupGuide() {
  const [currentStep, setCurrentStep] = useState(1);

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 to-orange-50">
      {/* Header */}
      <header className="bg-white shadow-md px-6 py-4 flex items-center justify-between">
        <Link
          to="/"
          className="text-2xl font-bold text-amber-600 hover:text-amber-700 flex items-center gap-2"
        >
          <span className="text-2xl">🙌</span>
          <span>HighFive</span>
        </Link>
        <Link
          to="/web-installer"
          className="text-gray-600 hover:text-gray-800"
        >
          ← Zurück zum Installer
        </Link>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto py-12 px-4">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          {/* Titel */}
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-gray-900 mb-3">
              Setup Guide
            </h1>
            <p className="text-lg text-gray-600">
              Richte deinen HighFive ESP32 in 3 einfachen Schritten ein
            </p>
          </div>

          {/* Progress Bar */}
          <div className="flex items-center justify-between mb-12">
            {[1, 2, 3].map((step) => (
              <div key={step} className="flex items-center flex-1">
                <div
                  className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg ${
                    currentStep >= step
                      ? 'bg-amber-500 text-white'
                      : 'bg-gray-200 text-gray-500'
                  }`}
                >
                  {step}
                </div>
                {step < 3 && (
                  <div
                    className={`flex-1 h-1 mx-2 ${
                      currentStep > step ? 'bg-amber-500' : 'bg-gray-200'
                    }`}
                  />
                )}
              </div>
            ))}
          </div>

          {/* Step 1: WiFi Setup */}
          <div className="mb-10 p-6 bg-amber-50 rounded-xl border-2 border-amber-200">
            <h2 className="text-2xl font-bold text-gray-900 mb-4 flex items-center gap-3">
              <span className="text-3xl">📡</span>
              Schritt 1: WiFi-Konfiguration
            </h2>
            <div className="space-y-3 text-gray-700">
              <p className="font-semibold">Nach dem Flashen startet der ESP32 automatisch:</p>
              <ol className="list-decimal list-inside space-y-2 ml-4">
                <li>Der ESP32 erstellt ein WiFi-Netzwerk namens <code className="bg-white px-2 py-1 rounded">HighFive-Setup-XXXX</code></li>
                <li>Verbinde dein Smartphone oder Laptop mit diesem Netzwerk</li>
                <li>Ein Konfigurationsfenster öffnet sich automatisch (Captive Portal)</li>
                <li>Wähle dein Heim-WiFi aus und gib das Passwort ein</li>
                <li>Klicke auf "Speichern" - der ESP32 startet neu und verbindet sich</li>
              </ol>
              <div className="bg-yellow-100 border-l-4 border-yellow-500 p-4 mt-4">
                <p className="text-sm">
                  <strong>💡 Tipp:</strong> Falls kein Fenster aufgeht, öffne manuell <code>192.168.4.1</code> im Browser
                </p>
              </div>
            </div>
          </div>

          {/* Step 2: Backend Connection */}
          <div className="mb-10 p-6 bg-blue-50 rounded-xl border-2 border-blue-200">
            <h2 className="text-2xl font-bold text-gray-900 mb-4 flex items-center gap-3">
              <span className="text-3xl">🔌</span>
              Schritt 2: Backend-Verbindung
            </h2>
            <div className="space-y-3 text-gray-700">
              <p>Verbinde deinen ESP32 mit dem HighFive Backend:</p>
              <div className="bg-white p-4 rounded-lg border border-blue-300 space-y-3">
                <div>
                  <label className="block font-semibold mb-1">Backend URL:</label>
                  <code className="block bg-gray-100 px-3 py-2 rounded">https://api.highfive.example.com</code>
                </div>
                <div>
                  <label className="block font-semibold mb-1">API Key:</label>
                  <input
                    type="text"
                    placeholder="Dein API-Key hier eingeben"
                    className="w-full px-3 py-2 border border-gray-300 rounded"
                  />
                </div>
                <button className="w-full bg-blue-500 hover:bg-blue-600 text-white py-2 rounded-lg font-semibold">
                  Verbindung testen
                </button>
              </div>
              <p className="text-sm text-gray-600 mt-3">
                Den API-Key erhältst du nach der Registrierung auf dem Dashboard
              </p>
            </div>
          </div>

          {/* Step 3: Placement */}
          <div className="mb-8 p-6 bg-green-50 rounded-xl border-2 border-green-200">
            <h2 className="text-2xl font-bold text-gray-900 mb-4 flex items-center gap-3">
              <span className="text-3xl">🏡</span>
              Schritt 3: Modul platzieren
            </h2>
            <div className="space-y-3 text-gray-700">
              <p className="font-semibold">Wichtige Hinweise zur optimalen Platzierung:</p>
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <span className="text-green-600 font-bold">☀️</span>
                  <div>
                    <strong>Süd-Ausrichtung:</strong> Für optimale Solaraufladung sollte das Modul nach Süden zeigen
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-600 font-bold">🌧️</span>
                  <div>
                    <strong>Wetterschutz:</strong> Stelle sicher, dass Kamera und Elektronik vor Regen geschützt sind
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-600 font-bold">📏</span>
                  <div>
                    <strong>Höhe:</strong> Montiere das Modul in 1-2m Höhe für gute Sicht auf die Nisthilfe
                  </div>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-green-600 font-bold">🐝</span>
                  <div>
                    <strong>Nisthilfe:</strong> Platziere die Wildbienen-Nisthilfe direkt vor der Kamera
                  </div>
                </li>
              </ul>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 mt-8">
            <Link
              to="/dashboard"
              className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-3 rounded-lg font-semibold text-center transition-colors"
            >
              Zum Dashboard →
            </Link>
            <Link
              to="/"
              className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-800 py-3 rounded-lg font-semibold text-center transition-colors"
            >
              Zur Startseite
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
