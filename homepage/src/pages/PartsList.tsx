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
          <h1 className="text-4xl font-bold text-gray-900 mb-3">Parts List</h1>
          <p className="text-lg text-gray-600">Everything you need to build your own HighFive module</p>
        </div>

        {/* Electronics */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-4 border-b pb-2">Electronics</h2>
          <div className="space-y-4">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">ESP32-CAM Module</h3>
                <p className="text-sm text-gray-600">With OV2640 camera sensor</p>
              </div>
              <span className="text-amber-600 font-semibold">~10€</span>
            </div>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">USB-UART Adapter</h3>
                <p className="text-sm text-gray-600">CP2102 or FTDI FT232RL</p>
              </div>
              <span className="text-amber-600 font-semibold">~5€</span>
            </div>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">MicroSD Card</h3>
                <p className="text-sm text-gray-600">8-32GB, Class 10</p>
              </div>
              <span className="text-amber-600 font-semibold">~8€</span>
            </div>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">5V Power Supply</h3>
                <p className="text-sm text-gray-600">2A minimum, USB or DC adapter</p>
              </div>
              <span className="text-amber-600 font-semibold">~7€</span>
            </div>
          </div>
        </div>

        {/* Power Management (Optional) */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-4 border-b pb-2">
            Power Management <span className="text-sm font-normal text-gray-500">(Optional for solar)</span>
          </h2>
          <div className="space-y-4">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">Solar Panel</h3>
                <p className="text-sm text-gray-600">6V 6W recommended</p>
              </div>
              <span className="text-amber-600 font-semibold">~15€</span>
            </div>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">18650 Battery</h3>
                <p className="text-sm text-gray-600">3.7V Li-ion with holder</p>
              </div>
              <span className="text-amber-600 font-semibold">~8€</span>
            </div>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">TP4056 Charging Module</h3>
                <p className="text-sm text-gray-600">Solar charge controller</p>
              </div>
              <span className="text-amber-600 font-semibold">~2€</span>
            </div>
          </div>
        </div>

        {/* Housing & Mounting */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-4 border-b pb-2">Housing & Mounting</h2>
          <div className="space-y-4">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">Weatherproof Enclosure</h3>
                <p className="text-sm text-gray-600">IP65 rated, min. 100x100x50mm</p>
              </div>
              <span className="text-amber-600 font-semibold">~12€</span>
            </div>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">Mounting Bracket</h3>
                <p className="text-sm text-gray-600">L-bracket or custom 3D print</p>
              </div>
              <span className="text-amber-600 font-semibold">~5€</span>
            </div>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">Cable Glands</h3>
                <p className="text-sm text-gray-600">For weatherproof cable entry</p>
              </div>
              <span className="text-amber-600 font-semibold">~3€</span>
            </div>
          </div>
        </div>

        {/* Miscellaneous */}
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-4 border-b pb-2">Miscellaneous</h2>
          <div className="space-y-4">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">Jumper Wires</h3>
                <p className="text-sm text-gray-600">Male-to-Female, 10-20cm</p>
              </div>
              <span className="text-amber-600 font-semibold">~3€</span>
            </div>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">USB Cable</h3>
                <p className="text-sm text-gray-600">USB-A to Micro-USB</p>
              </div>
              <span className="text-amber-600 font-semibold">~3€</span>
            </div>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-semibold text-gray-900">Screws & Hardware</h3>
                <p className="text-sm text-gray-600">M3 screws, standoffs, nuts</p>
              </div>
              <span className="text-amber-600 font-semibold">~5€</span>
            </div>
          </div>
        </div>

        {/* Total */}
        <div className="bg-gradient-to-r from-amber-500 to-orange-500 rounded-lg p-6 text-white">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold">Estimated Total</h2>
            <div className="text-right">
              <p className="text-3xl font-bold">~60-85€</p>
              <p className="text-sm text-amber-100">Basic setup: ~40€ | With solar: ~85€</p>
            </div>
          </div>
          <div className="bg-white bg-opacity-20 rounded p-3 text-sm">
            <p><strong>Note:</strong> Prices are estimates and may vary by supplier. Check online marketplaces like Amazon, AliExpress, or local electronics stores.</p>
          </div>
        </div>

        {/* CTA */}
        <div className="mt-8 text-center">
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
