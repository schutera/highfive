import { Link } from 'react-router-dom';

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
          <p className="text-lg text-gray-600">Complete setup in two simple steps</p>
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
