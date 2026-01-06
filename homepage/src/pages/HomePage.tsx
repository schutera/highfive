import { Link } from 'react-router-dom';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-yellow-50 to-orange-50">
      {/* Hero Section */}
      <section className="relative h-screen flex items-center justify-center overflow-hidden">
        <div 
          className="absolute inset-0 z-0"
          style={{
        backgroundImage: 'url(/heroimage_hive.jpg)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        filter: 'brightness(0.7)'
          }}
        />
        {/* Overlay */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/20 to-black/60 z-10" />
        
        {/* Content */}
        <div className="relative z-20 text-center px-4 max-w-5xl">
          <h1 className="text-7xl md:text-9xl font-bold text-white mb-6 drop-shadow-2xl">
        🙌 HighFive
          </h1>
          <p className="text-2xl md:text-4xl text-amber-100 mb-8 font-light">
        /haɪv/ /haɪv/
          </p>
          <p className="text-xl md:text-2xl text-white/90 mb-12 max-w-3xl mx-auto">
        We believe that wild bees are an underestimated bio marker for the health of our environment. 
        Our mission is to make this information accessible and actionable for everyone.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4 md:gap-6 justify-center items-center">
        <Link 
          to="/dashboard"
          className="w-full sm:w-auto bg-amber-500 hover:bg-amber-600 text-white px-8 md:px-12 py-3 md:py-5 rounded-full text-lg md:text-xl font-semibold shadow-2xl transition-all transform hover:scale-105 flex items-center justify-center"
        >
          View Dashboard
        </Link>
        <a 
          href="#how-it-works"
          className="w-full sm:w-auto bg-white/10 backdrop-blur-md hover:bg-white/20 text-white px-8 md:px-12 py-3 md:py-5 rounded-full text-lg md:text-xl font-semibold border-2 border-white/30 transition-all flex items-center justify-center"
        >
          How It Works
        </a>
          </div>
        </div>

        {/* Scroll Indicator */}
        <div className="absolute left-1/2 bottom-10 -translate-x-1/2 z-20 flex justify-center w-full pointer-events-none">
          <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </div>
      </section>

      {/* How It Works Section */}
      <section id="how-it-works" className="py-16 md:py-24 px-3 md:px-4 bg-white">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-bold text-center text-gray-900 mb-12 md:mb-16">
            Get Started in 3 Steps
          </h2>

          <div className="flex flex-col gap-8 md:gap-12 max-w-2xl mx-auto">
            {/* Step 1 */}
            <div className="relative">
              <div className="bg-gradient-to-br from-amber-400 to-orange-500 w-14 h-14 md:w-16 md:h-16 rounded-full flex items-center justify-center text-white text-2xl md:text-3xl font-bold mb-4 md:mb-6 shadow-lg">
                1
              </div>
              <h3 className="text-xl md:text-2xl font-bold text-gray-900 mb-2 md:mb-4">Get Hardware</h3>
              <p className="text-sm md:text-base text-gray-600 leading-relaxed mb-4 md:mb-6">
                Choose your preferred option to get started with the monitoring hardware.
              </p>
              
              {/* Option 1: Buy Kit */}
              <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-lg p-3 md:p-4 mb-3 md:mb-4 border-2 border-amber-200">
                <h4 className="font-bold text-sm md:text-base text-gray-900 mb-2">🎁 Complete Kit</h4>
                <p className="text-xs md:text-sm text-gray-600 mb-3">
                  Get everything pre-assembled and ready to use
                </p>
                <a 
                  href="#buy-kit" 
                  className="flex items-center justify-center w-full bg-amber-500 hover:bg-amber-600 text-white px-3 md:px-4 py-2 rounded-lg font-semibold text-sm md:text-base transition-colors"
                >
                  Buy Complete Kit →
                </a>
              </div>

              {/* Option 2: DIY */}
              <div className="bg-gray-50 rounded-lg p-3 md:p-4 border-2 border-gray-200">
                <h4 className="font-bold text-sm md:text-base text-gray-900 mb-2">🔧 Build It Yourself</h4>
                <p className="text-xs md:text-sm text-gray-600 mb-2">
                  Components you'll need:
                </p>
                <ul className="text-xs text-gray-700 space-y-1 mb-3">
                  <li className="flex items-start">
                    <span className="text-amber-500 mr-2">•</span>
                    ESP32-CAM module
                  </li>
                  <li className="flex items-start">
                    <span className="text-amber-500 mr-2">•</span>
                    Power supply & cables
                  </li>
                  <li className="flex items-start">
                    <span className="text-amber-500 mr-2">•</span>
                    Wood structure for mounting
                  </li>
                </ul>
                <a 
                  href="#diy-guide" 
                  className="flex items-center justify-center w-full bg-gray-200 hover:bg-gray-300 text-gray-800 px-3 md:px-4 py-2 rounded-lg font-semibold text-sm md:text-base transition-colors"
                >
                  View Parts List →
                </a>
              </div>
            </div>

            {/* Step 2 */}
            <div className="relative">
              <div className="bg-gradient-to-br from-amber-400 to-orange-500 w-14 h-14 md:w-16 md:h-16 rounded-full flex items-center justify-center text-white text-2xl md:text-3xl font-bold mb-4 md:mb-6 shadow-lg">
                2
              </div>
              <h3 className="text-xl md:text-2xl font-bold text-gray-900 mb-2 md:mb-4">Flash & Setup</h3>
              <p className="text-sm md:text-base text-gray-600 leading-relaxed mb-3 md:mb-4">
                Connect your ESP32-CAM to your computer and use our installer to flash the firmware.
              </p>
              
              <div className="bg-blue-50 rounded-lg p-3 md:p-4 border-2 border-blue-200">
                <h4 className="font-bold text-sm md:text-base text-gray-900 mb-2">📡 Web Installer</h4>
                <p className="text-xs md:text-sm text-gray-600 mb-3">
                  Simple browser-based installer - works on all platforms, no downloads or drivers needed
                </p>
                <a 
                  href="#web-installer" 
                  className="flex items-center justify-center w-full bg-blue-500 hover:bg-blue-600 text-white px-3 md:px-4 py-2 rounded-lg font-semibold text-sm md:text-base transition-colors"
                >
                  Launch Web Installer →
                </a>
              </div>
            </div>

            {/* Step 3 */}
            <div className="relative">
              <div className="bg-gradient-to-br from-amber-400 to-orange-500 w-14 h-14 md:w-16 md:h-16 rounded-full flex items-center justify-center text-white text-2xl md:text-3xl font-bold mb-4 md:mb-6 shadow-lg">
                3
              </div>
              
              <h3 className="text-xl md:text-2xl font-bold text-gray-900 mb-2 md:mb-4">Discover & Contribute</h3>

              <p className="text-sm md:text-base text-gray-600 leading-relaxed mb-3 md:mb-4">
                Set up your hive module and monitor wild bee populations and contribute valuable data to help understand pollinator health in your area. 
              </p>
                            <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-lg p-3 md:p-4 mb-3 md:mb-4 border-2 border-green-200">
                <p className="text-xs md:text-sm text-gray-700 mb-2">
                  ✨ Join a community of citizen scientists making a real difference. Perfect for nature enthusiasts, researchers, policymakers, educators, agriculture professionals, and anyone interested tapping into biomarker data.
                </p>
              </div>
              <Link 
                to="/dashboard"
                className="mt-2 flex items-center justify-center w-full bg-amber-500 hover:bg-amber-600 text-white px-4 md:px-6 py-2 md:py-3 rounded-lg font-semibold text-sm md:text-base transition-colors"
              >
                Explore Dashboard →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      {/* <section className="py-24 px-4 bg-gradient-to-br from-amber-100 to-orange-100">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-5xl font-bold text-center text-gray-900 mb-16">
            Why HighFive?
          </h2>

          <div className="grid md:grid-cols-2 gap-8">
            <div className="bg-white rounded-2xl p-8 shadow-lg">
              <div className="text-4xl mb-4">🗺️</div>
              <h3 className="text-2xl font-bold text-gray-900 mb-3">Interactive Map</h3>
              <p className="text-gray-600">
                View all your monitoring stations on an interactive map. Click any module to see detailed metrics and live feeds.
              </p>
            </div>

            <div className="bg-white rounded-2xl p-8 shadow-lg">
              <div className="text-4xl mb-4">📊</div>
              <h3 className="text-2xl font-bold text-gray-900 mb-3">Species Tracking</h3>
              <p className="text-gray-600">
                Identify and track up to 4 different bee species. Visualize population trends over time with beautiful charts.
              </p>
            </div>

            <div className="bg-white rounded-2xl p-8 shadow-lg">
              <div className="text-4xl mb-4">📸</div>
              <h3 className="text-2xl font-bold text-gray-900 mb-3">Live Camera Feed</h3>
              <p className="text-gray-600">
                Stream live video from your ESP32-CAM modules. Capture images and analyze bee behavior in real-time.
              </p>
            </div>

            <div className="bg-white rounded-2xl p-8 shadow-lg">
              <div className="text-4xl mb-4">💾</div>
              <h3 className="text-2xl font-bold text-gray-900 mb-3">Data Analytics</h3>
              <p className="text-gray-600">
                Store and analyze historical data. Export datasets for research or integrate with external tools.
              </p>
            </div>
          </div>
        </div>
      </section> */}

      {/* Footer */}
      <footer className="bg-gray-900 text-white py-12 px-4">
        <div className="max-w-6xl mx-auto text-center">
          <p className="text-gray-400">Built with 💛 for wild bees everywhere</p>
          <div className="mt-6">
            <a href="https://partner.schutera.com/impressum" className="text-amber-400 hover:text-amber-300 mx-4">
              Impressum
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
