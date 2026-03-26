import { useState } from 'react';
import { Link } from 'react-router-dom';

function TroubleshootingItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white rounded-lg shadow mb-3">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex justify-between items-center p-5 text-left"
      >
        <span className="font-semibold text-gray-900">{question}</span>
        <span className="text-amber-500 text-xl shrink-0 ml-4">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 text-gray-700 text-sm border-t border-gray-100 pt-3">
          {answer}
        </div>
      )}
    </div>
  );
}


export default function SetupGuide() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-xl font-bold text-amber-600 hover:text-amber-700">
            HighFive
          </Link>
          <Link to="/web-installer" className="text-sm text-gray-600 hover:text-gray-900">
            Back to Installer
          </Link>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto py-12 px-4">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-3">Setup Guide</h1>
          <p className="text-lg text-gray-600">Complete setup in three simple steps</p>
        </div>

        <div className="space-y-6">
          {/* Step 1: WiFi */}
          <div className="bg-white rounded-lg shadow p-6 border-l-4 border-amber-500">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Step 1: WiFi Configuration</h2>
            <p className="text-gray-700 mb-3">After flashing, the ESP32 creates a WiFi access point:</p>
            <ol className="list-decimal list-inside space-y-2 text-gray-700 ml-4">
              <li>Search for WiFi network <code className="bg-gray-100 px-2 py-1 rounded">HighFive-Setup-XXXX</code></li>
              <li>Connect to the network</li>
              <li>Configuration portal opens automatically</li>
              <li>Enter your home WiFi credentials</li>
              <li>Save - ESP32 restarts and connects</li>
            </ol>
            <div className="bg-blue-50 border border-blue-200 rounded p-3 mt-4">
              <p className="text-sm text-blue-900">
                <strong>Note:</strong> If portal doesn't open, navigate to <code className="bg-blue-100 px-2 py-1 rounded">192.168.4.1</code>
              </p>
            </div>
          </div>

          {/* Step 2: Deployment */}
          <div className="bg-white rounded-lg shadow p-6 border-l-4 border-green-500">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Step 2: Module Deployment</h2>
            <p className="text-gray-700 mb-3">Optimal placement guidelines:</p>
            <ul className="space-y-2 text-gray-700 ml-4">
              <li className="flex items-start gap-2">
                <span className="text-amber-600 font-bold">•</span>
                <span><strong>South-facing:</strong> For optimal solar charging</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-amber-600 font-bold">•</span>
                <span><strong>Weather protection:</strong> Shield from direct rain</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-amber-600 font-bold">•</span>
                <span><strong>Height:</strong> 1-2 meters for good viewing angle</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-amber-600 font-bold">•</span>
                <span><strong>Alignment:</strong> Bee hotel in camera view</span>
              </li>
            </ul>
          </div>
        </div>

         {/* Step 3: Backend Configuration */}
          <div className="bg-white rounded-lg shadow p-6 border-l-4 border-blue-500">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Step 3: Backend Configuration</h2>
            <p className="text-gray-700 mb-3">Connect the module to your HighFive server:</p>
            <ol className="list-decimal list-inside space-y-2 text-gray-700 ml-4">
              <li>Open the configuration page at <code className="bg-gray-100 px-2 py-1 rounded">192.168.4.1</code></li>
              <li>Enter the <strong>Initialization Base URL</strong> — IP and port of your server (default port: <code className="bg-gray-100 px-2 py-1 rounded">8002</code>)</li>
              <li>Set <strong>Initialization Endpoint</strong> to <code className="bg-gray-100 px-2 py-1 rounded">/new_module</code></li>
              <li>Enter the <strong>Upload Base URL</strong> — IP and port of the classification server (default port: <code className="bg-gray-100 px-2 py-1 rounded">8000</code>)</li>
              <li>Set <strong>Upload Endpoint</strong> to <code className="bg-gray-100 px-2 py-1 rounded">/upload</code></li>
              <li>Save — the module registers itself and starts uploading images</li>
            </ol>
            <div className="bg-amber-50 border border-amber-200 rounded p-3 mt-4">
              <p className="text-sm text-amber-900">
                <strong>Note:</strong> Backend and classification service must be running before the module connects. See the deployment guide for setup instructions.
              </p>
            </div>

                    {/* Troubleshooting */}
        <div className="mt-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">Troubleshooting</h2>
          <TroubleshootingItem
            question="The HiveHive-Access-Point network does not appear"
            answer="Disconnect the module from power, wait 5 seconds, then plug it in again. If the network still does not appear, the firmware may not have been flashed correctly — repeat the web installer step."
          />
          <TroubleshootingItem
            question="The configuration page at 192.168.4.1 does not open"
            answer="Make sure you are connected to HiveHive-Access-Point and not your home Wi-Fi. If the page still does not open, type 192.168.4.1 manually into your browser address bar."
          />
          <TroubleshootingItem
            question="The ESP32 is not detected in the web installer"
            answer="Try a different USB cable — many cables are charge-only and do not transfer data. Also make sure you are using Google Chrome or Microsoft Edge. Other browsers do not support the Web Serial API required for flashing."
          />
          <TroubleshootingItem
            question="The module does not appear on the dashboard after configuration"
            answer="Check that the backend server is running on the correct port (8002). Verify that the Initialization Base URL and endpoint are correct. The module constructs the full request as Base URL + Endpoint, for example: http://192.168.1.10:8002/new_module."
          />
          <TroubleshootingItem
            question="The module connects to Wi-Fi but does not upload images"
            answer="Check that the image processing server is running on port 8000 and the Upload Endpoint is set to /upload. You can monitor upload attempts via the Serial Monitor in Arduino IDE at baud rate 115200."
          />
          <TroubleshootingItem
            question="How do I reconfigure the module after initial setup?"
            answer="Press and hold the left button on the module for 10–15 seconds. This performs a factory reset and the module reopens the HiveHive-Access-Point for reconfiguration."
          />
        </div>

          </div>


        {/* CTA */}
        <div className="mt-8 bg-gradient-to-r from-amber-500 to-orange-500 rounded-lg p-6 text-center">
          <h3 className="text-2xl font-bold text-white mb-3">Ready to Start</h3>
          <p className="text-white mb-4">Access the dashboard to view your data</p>
          <div className="flex gap-3 justify-center">
            <Link
              to="/dashboard"
              className="px-6 py-2 bg-white text-amber-600 rounded font-semibold hover:bg-gray-100"
            >
              Open Dashboard
            </Link>
            <Link
              to="/"
              className="px-6 py-2 bg-amber-600 text-white rounded font-semibold hover:bg-amber-700"
            >
              Home
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
