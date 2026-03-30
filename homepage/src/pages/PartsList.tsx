import { Link } from 'react-router-dom';

export default function PartsList() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link to="/" className="text-xl font-bold text-amber-600 hover:text-amber-700">
            HighFive
          </Link>
          <Link to="/" className="text-sm text-gray-600 hover:text-gray-900">
            Back to Home
          </Link>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto py-12 px-4">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-3">Parts List & Assembly Guide</h1>
          <p className="text-lg text-gray-600">Everything you need to build your own HighFive module</p>
        </div>

        {/* Edge Device */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-4 border-b pb-2">Edge Device</h2>
          <div className="space-y-4">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">ESP32-CAM Development Board</h3>
                <p className="text-sm text-gray-600">Microcontroller with integrated camera module</p>
              </div>
              <span className="text-amber-600 font-semibold">8–12€</span>
            </div>
          </div>
        </div>

        {/* Power System */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-4 border-b pb-2">Power System</h2>
          <div className="space-y-4">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">PV Module</h3>
                <p className="text-sm text-gray-600">10 Wp mono 12 V panel</p>
              </div>
              <span className="text-amber-600 font-semibold">12–18€</span>
            </div>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">Charge Controller</h3>
                <p className="text-sm text-gray-600">CN3791 MPPT single-cell module</p>
              </div>
              <span className="text-amber-600 font-semibold">2–4€</span>
            </div>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">Battery Pack</h3>
                <p className="text-sm text-gray-600">2 × LiFePO₄ 3.2 V, 3–4 Ah</p>
              </div>
              <span className="text-amber-600 font-semibold">8–16€</span>
            </div>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">BMS</h3>
                <p className="text-sm text-gray-600">1S LiFePO₄ BMS with temp. cut-off</p>
              </div>
              <span className="text-amber-600 font-semibold">3–5€</span>
            </div>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">Boost Converter</h3>
                <p className="text-sm text-gray-600">MT3608 3.2 V → 5 V module</p>
              </div>
              <span className="text-amber-600 font-semibold">2–4€</span>
            </div>
          </div>
        </div>

        {/* Total */}
        <div className="bg-gradient-to-r from-amber-500 to-orange-500 rounded-lg p-6 text-white mb-12">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold">Estimated Total</h2>
            <div className="text-right">
              <p className="text-3xl font-bold">35–59€</p>
              <p className="text-sm text-amber-100">All components included</p>
            </div>
          </div>
          <div className="bg-white bg-opacity-20 rounded p-3 text-sm">
            <p><strong>Note:</strong> Prices are estimates and may vary by supplier. Check online marketplaces like Amazon, AliExpress, or local electronics stores.</p>
          </div>
        </div>

        {/* Assembly Guide */}
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold text-gray-900 mb-3">Assembly Guide</h2>
          <p className="text-lg text-gray-600">Step-by-step instructions to get your module running</p>
        </div>

        {/* Step 1 */}
        <div className="bg-white rounded-lg shadow p-6 mb-6 border-l-4 border-amber-500">
          <div className="flex items-center gap-3 mb-4">
            <div className="bg-amber-500 text-white w-8 h-8 rounded-full flex items-center justify-center font-bold shrink-0">1</div>
            <h3 className="text-xl font-bold text-gray-900">Connect the power supply</h3>
          </div>
          <p className="text-gray-700 mb-3">Wire the power system before connecting the ESP32-CAM:</p>
          <ol className="list-decimal list-inside space-y-2 text-gray-700 ml-4">
            <li>Connect the solar panel output to the CN3791 charge controller input</li>
            <li>Connect the two LiFePO₄ cells in series to the BMS</li>
            <li>Connect the BMS output to the MT3608 boost converter input</li>
            <li>Set the boost converter output to 5 V before connecting the ESP32-CAM</li>
            <li>Connect the boost converter 5 V output to the ESP32-CAM VCC and GND pins</li>
          </ol>
          <div className="bg-amber-50 border border-amber-200 rounded p-3 mt-4">
            <p className="text-sm text-amber-900"><strong>Note:</strong> Double-check polarity before powering on. Reverse polarity will damage the ESP32-CAM.</p>
          </div>
        </div>

        {/* Step 2 */}
        <div className="bg-white rounded-lg shadow p-6 mb-6 border-l-4 border-amber-500">
          <div className="flex items-center gap-3 mb-4">
            <div className="bg-amber-500 text-white w-8 h-8 rounded-full flex items-center justify-center font-bold shrink-0">2</div>
            <h3 className="text-xl font-bold text-gray-900">Flash the firmware</h3>
          </div>
          <p className="text-gray-700 mb-3">Before the module can operate, the firmware must be flashed via the web installer:</p>
          <ol className="list-decimal list-inside space-y-2 text-gray-700 ml-4">
            <li>Connect the ESP32-CAM to your computer via USB</li>
            <li>Open the web installer in Google Chrome or Microsoft Edge</li>
            <li>Select the detected device and click <strong>Install firmware</strong></li>
            <li>Do not disconnect the USB cable during the process</li>
            <li>Once complete, disconnect the USB cable</li>
          </ol>
        </div>

        {/* Step 3 */}
        <div className="bg-white rounded-lg shadow p-6 mb-6 border-l-4 border-amber-500">
          <div className="flex items-center gap-3 mb-4">
            <div className="bg-amber-500 text-white w-8 h-8 rounded-full flex items-center justify-center font-bold shrink-0">3</div>
            <h3 className="text-xl font-bold text-gray-900">Configure the module</h3>
          </div>
          <p className="text-gray-700 mb-3">On first startup, the module opens its own Wi-Fi access point for configuration:</p>
          <ol className="list-decimal list-inside space-y-2 text-gray-700 ml-4">
            <li>Power on the module — it creates the Wi-Fi network <code className="bg-gray-100 px-2 py-1 rounded">HiveHive-Access-Point</code></li>
            <li>Connect your phone or laptop to that network</li>
            <li>Open a browser and go to <code className="bg-gray-100 px-2 py-1 rounded">192.168.4.1</code></li>
            <li>Enter your <strong>Wi-Fi SSID and password</strong> (the module name is auto-generated)</li>
            <li>Enter the <strong>Initialization Base URL</strong> (your server IP, port <code className="bg-gray-100 px-2 py-1 rounded">8002</code>) and endpoint <code className="bg-gray-100 px-2 py-1 rounded">/new_module</code></li>
            <li>Enter the <strong>Upload Base URL</strong> (your server IP, port <code className="bg-gray-100 px-2 py-1 rounded">8000</code>) and endpoint <code className="bg-gray-100 px-2 py-1 rounded">/upload</code></li>
            <li>Save — the module restarts, registers itself, and begins uploading images automatically</li>
          </ol>
          <div className="bg-blue-50 border border-blue-200 rounded p-3 mt-4">
            <p className="text-sm text-blue-900"><strong>Note:</strong> If the configuration page does not open automatically, navigate manually to <code className="bg-blue-100 px-2 py-1 rounded">192.168.4.1</code>. The module requires a <strong>2.4 GHz</strong> Wi-Fi network.</p>
          </div>
        </div>

        {/* Step 4 */}
        <div className="bg-white rounded-lg shadow p-6 mb-6 border-l-4 border-green-500">
          <div className="flex items-center gap-3 mb-4">
            <div className="bg-green-500 text-white w-8 h-8 rounded-full flex items-center justify-center font-bold shrink-0">4</div>
            <h3 className="text-xl font-bold text-gray-900">Mount the module outdoors</h3>
          </div>
          <p className="text-gray-700 mb-3">Placement directly affects solar charging and image quality:</p>
          <ul className="space-y-2 text-gray-700 ml-4">
            <li className="flex items-start gap-2">
              <span className="text-amber-600 font-bold shrink-0">•</span>
              <span><strong>South-facing:</strong> Orient the solar panel south for maximum solar gain</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-amber-600 font-bold shrink-0">•</span>
              <span><strong>Camera alignment:</strong> Point the camera directly at the bee hotel entrance holes</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-amber-600 font-bold shrink-0">•</span>
              <span><strong>Weather protection:</strong> Shield electronics from direct rain — the enclosure must be sealed</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-amber-600 font-bold shrink-0">•</span>
              <span><strong>Height:</strong> Mount at 1–2 meters for a good camera viewing angle</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-amber-600 font-bold shrink-0">•</span>
              <span><strong>Temperature range:</strong> Components rated for −20 °C to +50 °C operation</span>
            </li>
          </ul>
        </div>

        {/* Factory Reset note */}
        <div className="bg-gray-100 rounded-lg p-4 mb-8 text-sm text-gray-700">
          <strong>Factory Reset:</strong> To reconfigure the module, press and hold the <strong>left button</strong> for 10–15 seconds. The configuration resets and the module reopens its access point.
        </div>

        {/* CTA */}
        <div className="mt-4 text-center">
          <Link
            to="/web-installer"
            className="inline-block px-8 py-3 bg-amber-600 text-white rounded-lg font-semibold hover:bg-amber-700 transition-colors"
          >
            Ready to flash firmware →
          </Link>
        </div>
      </main>
    </div>
  );
}
