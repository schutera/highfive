const translations = {
  en: {
    // ---- Common ----
    common: {
      back: 'Back',
      next: 'Next',
      online: 'Online',
      offline: 'Offline',
      loading: 'Loading...',
      error: 'Error',
      tryAgain: 'Try Again',
      copy: 'Copy',
      copied: 'Copied!',
      reloadPage: 'Reload Page',
      impressum: 'Impressum',
      hiveModules: 'Hive Modules',
      backToHome: 'Back to Home',
    },

    // ---- Home Page ----
    home: {
      heroSubtitle: '/ha\u026Av/ /ha\u026Av/',
      heroText:
        'We believe that wild bees are an underestimated bio marker for the health of our environment. Our mission is to make this information accessible and actionable for everyone.',
      viewDashboard: 'View Dashboard',
      howItWorks: 'How It Works',
      getStartedTitle: 'Get Started in 3 Steps',
      step1Title: 'Get Your Hive Module',
      step1Text:
        'Order pre-cut wooden parts, download CAD files to laser it yourself, and see what electronics you\u2019ll need.',
      step1Cta: 'The Hive Module \u2192',
      step2Title: 'Flash & Setup',
      step2Text:
        'Connect your ESP32-CAM to your computer and use our installer to flash the firmware.',
      step2GuidedTitle: '\uD83D\uDCE1 Guided Setup',
      step2GuidedText:
        'Our setup wizard walks you through flashing, configuring, and connecting your module \u2014 step by step',
      step2Cta: 'Start Setup \u2192',
      step3Title: 'Discover & Contribute',
      step3Text:
        'Set up your hive module and monitor wild bee populations and contribute valuable data to help understand pollinator health in your area.',
      step3Community:
        '\u2728 Join a community of citizen scientists making a real difference. Perfect for nature enthusiasts, researchers, policymakers, educators, agriculture professionals, and anyone interested tapping into biomarker data.',
      step3Cta: 'Explore Dashboard \u2192',
      footer: 'Built with \uD83D\uDC9B for wild bees everywhere',
    },

    // ---- Dashboard ----
    dashboard: {
      title: 'Dashboard',
      modulesInView: '{count} modules in view',
      inViewTap: '{count} in view \u2022 Tap to expand',
      moduleDetails: 'Module Details',
      errorTitle: "It's not you, it's us!",
      errorSubtitle: 'Our worker bees are already on it.',
      errorDetail: 'Failed to load modules. Make sure the backend is running.',
      loadingMap: 'Loading map...',
      onlineCount: '{online}/{total}',
      statusOnline: '\u25CF Online',
      statusOffline: '\u25CB Offline',
    },

    // ---- Module Panel ----
    modulePanel: {
      lastUpdate: 'Last update: {time}',
      hatches: 'hatches',
      images: 'images',
      nest: 'Nest {index}',
      moduleNotFound: 'Module not found',
      failedToLoad: 'Failed to load module details',
    },

    // ---- Admin key (telemetry gate) ----
    adminKey: {
      telemetry: 'Telemetry',
      formLabel: 'Admin key entry',
      label: 'Admin key',
      placeholder: 'Enter admin key',
      unlock: 'Unlock',
      cancel: 'Cancel',
      forget: 'Forget admin key',
      refresh: 'Refresh',
      invalid: 'Invalid key. Please try again.',
      loading: 'Loading telemetry…',
      loadFailed: 'Failed to load telemetry.',
      empty: 'No telemetry yet. Logs arrive with each uploaded image.',
    },

    // ---- Hive Module Page ----
    hiveModule: {
      pageTitle: 'Hive Module',
      heroTitle: 'The Hive Module',
      heroText:
        'A standardized bee nesting structure with an integrated camera system. Monitor wild bee activity and contribute to biodiversity research.',
      orderTitle: 'Order Wooden Parts',
      orderText:
        'Pre-cut, laser-engraved wooden nesting structure. Ready to assemble \u2014 just add the electronics.',
      orderCta: 'Order Now',
      comingSoon: 'Coming Soon',
      diyTitle: 'Laser It Yourself',
      diyText:
        'Download the FreeCAD design file and cut the parts on your own laser cutter or at a local makerspace.',
      diyCta: 'Download CAD File (.FCStd)',
      electronicsTitle: "Electronics You'll Need",
      electronicsSubtitle:
        'These parts are available from Amazon, AliExpress, or your local electronics store.',
      toolsTitle: "Tools You'll Need",
      toolsSubtitle: 'A few basic tools for assembly and wiring.',
      tool: 'Tool',
      purpose: 'Purpose',
      estimatedTotal: 'Estimated Total',
      component: 'Component',
      description: 'Description',
      estPrice: 'Est. Price',
      ctaTitle: 'Got your parts?',
      ctaText:
        'Follow our step-by-step guide to assemble the wooden structure and wire the electronics.',
      ctaCta: 'Assemble the Hive Module',
      // Parts
      esp32cam: 'ESP32-CAM',
      esp32camDesc: 'Microcontroller with integrated camera module',
      pvModule: 'PV Module',
      pvModuleDesc: '10 Wp mono 12 V solar panel',
      chargeController: 'Charge Controller',
      chargeControllerDesc: 'CN3791 MPPT single-cell module',
      batteryPack: 'Battery Pack',
      batteryPackDesc: '2 \u00D7 LiFePO\u2084 3.2 V, 3\u20134 Ah',
      bms: 'BMS',
      bmsDesc: '1S LiFePO\u2084 BMS with temp. cut-off',
      boostConverter: 'Boost Converter',
      boostConverterDesc: 'MT3608 3.2 V \u2192 5 V module',
      // Tools
      solderingIron: 'Soldering Iron',
      solderingIronDetail: 'For wiring the power system and ESP32-CAM connections',
      doubleSidedTape: 'Double-Sided Tape',
      doubleSidedTapeDetail: 'To mount the ESP32-CAM and secure components inside the module',
      smallScrewdriver: 'Small Screwdriver',
      smallScrewdriverDetail: 'Phillips head for tightening terminal blocks and mounting screws',
    },

    // ---- Assembly Guide ----
    assembly: {
      pageTitle: 'Assembly Guide',
      backToModule: 'Back to Hive Module',
      heroTitle: 'Assemble Your Hive Module',
      heroSubtitle:
        'Follow these steps to build your module from laser-cut wooden parts and electronics. Takes about 30\u201360 minutes.',
      photoStep: 'Photo: Step {n}',
      tips: 'Tips',
      factoryReset:
        'If you ever need to reconfigure your module, press and hold the left button on the ESP32-CAM for 10+ seconds. It will restart and reopen the WiFi configuration portal.',
      factoryResetLabel: 'Factory Reset:',
      ctaTitle: 'Module assembled?',
      ctaText: 'Now flash the firmware and connect your module to the server.',
      ctaCta: 'Start Setup Wizard',
      steps: [
        {
          title: 'Prepare the Wooden Parts',
          description:
            'Lay out all laser-cut wooden pieces. Identify the base plate, side walls, inner dividers, and the capsule wall. Remove any protective film and lightly sand the edges if needed.',
          tips: [
            'Check all parts against the CAD drawing before starting',
            'Label each piece with a pencil if unsure about placement',
          ],
        },
        {
          title: 'Assemble the Frame',
          description:
            'Glue or interlock the side walls into the base plate. Attach the inner dividers to create four compartments by nest size. Each compartment holds four nesting tubes.',
          tips: [
            'Use wood glue for a permanent bond, or friction-fit for a disassemblable prototype',
            'Ensure the dividers sit flush \u2014 the camera needs a clear line of sight to all holes',
          ],
        },
        {
          title: 'Insert the Nesting Tubes',
          description:
            'Slide the nesting tubes into each compartment. The module supports four nest sizes with four tubes each (16 tubes total): 2 mm, 3 mm, 6 mm, and 9 mm.',
          tips: [
            'Use tubes matching the correct diameter for each species section',
            'Push tubes in until they are flush with the front face of the module',
          ],
        },
        {
          title: 'Attach the Capsule Wall',
          description:
            'Mount the capsule wall (front cover) onto the frame. This piece holds the camera window and protects the electronics compartment. Align it carefully before securing.',
          tips: [
            'The camera opening should be centered on the nesting tube grid',
            'Leave the capsule wall removable for maintenance access',
          ],
        },
        {
          title: 'Wire the Power System',
          description:
            'Connect the electronics in this order: Solar panel \u2192 CN3791 charge controller \u2192 LiFePO\u2084 batteries (via BMS) \u2192 MT3608 boost converter. Set the boost converter output to 5 V before connecting the ESP32-CAM.',
          tips: [
            'Double-check polarity at every connection \u2014 reverse polarity will damage the ESP32-CAM',
            'Use a multimeter to verify 5 V output from the boost converter before connecting the ESP',
            'Secure wires with cable ties or hot glue to prevent loose connections',
          ],
        },
        {
          title: 'Mount the ESP32-CAM',
          description:
            'Secure the ESP32-CAM inside the electronics compartment. Connect the 5 V and GND wires from the boost converter to the ESP32-CAM VCC and GND pins. Position the camera lens so it looks through the camera window at the nesting tubes.',
          tips: [
            'Use double-sided tape or a small bracket to fix the ESP32-CAM in place',
            'Ensure the camera lens is clean and properly focused on the tubes',
            'Route the USB port to be accessible for initial firmware flashing',
          ],
        },
        {
          title: 'Seal and Weatherproof',
          description:
            'Close the electronics compartment. Apply silicone sealant around cable entry points. Ensure the camera window is clean and sealed but not obstructed. The module should be rainproof while allowing the nesting tube openings to remain accessible to bees.',
          tips: [
            'Avoid sealing the nesting tube openings \u2014 bees need access',
            'Leave a small ventilation gap to prevent condensation inside the electronics compartment',
            'Consider a small overhang or roof to shield the camera from direct rain',
          ],
        },
      ],
    },

    // ---- Setup Wizard ----
    setup: {
      pageTitle: 'Module Setup',
      stepLabels: ['Connect', 'Flash', 'WiFi', 'Configure', 'Verify'],
    },

    // ---- Step 1: Connect ----
    step1: {
      title: 'Connect Your Module',
      text: "Plug your ESP32-CAM into your computer using a USB cable. Make sure it's a data cable, not a charge-only cable.",
      browserOk: 'Your browser supports USB serial',
      browserFail: 'Please use Chrome or Edge for firmware flashing',
      cableTip:
        "If your device isn't detected later, try a different USB cable. Some cables only carry power and can't transfer data.",
      tip: 'Tip:',
    },

    // ---- Step 2: Flash ----
    step2: {
      title: 'Flash Firmware',
      titleDone: 'Firmware Installed!',
      text: 'Click the button below to install the HighFive firmware on your ESP32-CAM.',
      textDone: "Your module is ready. Let's connect it to your network.",
      firmware: 'Firmware:',
      installBtn: 'Install Firmware',
      skipAlreadyFlashed: 'Skip \u2014 already flashed',
      usbHintLabel: 'What to expect after clicking the button',
      usbHint:
        'A small window will ask you to select a serial port. Your ESP32 usually shows up as "USB Serial Device", "CP2102", or "CH340".',
      usbHintDetail:
        'If you don\u2019t see any device, try a different USB cable \u2014 some cables only charge and can\u2019t transfer data.',
      stateConnecting: 'Connecting to device...',
      statePreparing: 'Preparing firmware...',
      stateErasing: 'Erasing flash memory...',
      stateWriting: 'Writing firmware...',
      stateFinished: 'Firmware installed successfully!',
      stateError: 'Flashing failed. Please try again.',
      errorHint:
        'Make sure the device is connected and try a different USB cable if the problem persists.',
      markComplete: 'Flash succeeded? Click here to continue',
      unplugTitle: 'Now unplug your ESP32 and plug it back in',
      unplugStep1: 'Disconnect the USB cable from your ESP32',
      unplugStep2: 'Wait about 5 seconds',
      unplugStep3: 'Plug it back in \u2014 the module will restart with the new firmware',
    },

    // ---- Step 3: WiFi ----
    step3: {
      title: 'Connect to Your Module',
      text: "Your module is now broadcasting its own WiFi network. Open your device's WiFi settings and connect to it.",
      networkName: 'Network Name',
      openNetwork: 'This is an open network \u2014 no password required.',
      disconnectNotice:
        "Your internet connection will temporarily disconnect when you connect to the module's network. That's completely normal.",
      connected: "I'm Connected",
      cantSeeNetwork: "Can't see the network?",
      troubleshoot: {
        resetTitle: 'Press the reset button',
        resetText:
          'Press the small reset button on the ESP32-CAM board. Wait 10 seconds for the network to appear.',
        waitTitle: 'Give it more time',
        waitText:
          'Some boards take up to 30 seconds to start the access point after a fresh flash.',
        reflashTitle: 'Go back and re-flash',
        reflashText:
          'If nothing works, go back to the previous step and flash the firmware again. Make sure you see 100% progress before continuing.',
      },
    },

    // ---- Step 4: Configure ----
    step4: {
      title: 'Configure Your Module',
      text: 'Enter your home WiFi details so your module can connect to the internet.',
      moduleName: 'Module Name',
      moduleNamePlaceholder: 'e.g. Garden Hive',
      wifiNetwork: 'WiFi Network (SSID)',
      wifiPlaceholder: 'Your WiFi name',
      wifiPassword: 'WiFi Password',
      wifiPasswordPlaceholder: 'Your WiFi password',
      saveBtn: 'Save Configuration',
      sending: 'Configuring your module...',
      error: 'Could not reach the module.',
      errorHint: 'Make sure you are connected to the HiveHive-Access-Point WiFi network.',
      reconnectTitle: 'Configuration Saved!',
      reconnectText:
        'Your module saved its settings and is restarting. Now switch back to your home WiFi.',
      reconnectWifiLabel: 'Switch your WiFi now:',
      reconnectStep1: 'Open your WiFi settings',
      reconnectStep2: 'Disconnect from HiveHive-Access-Point',
      reconnectStep3: 'Connect to your home WiFi network',
      reconnectBtn: "I'm on my home WiFi",
    },

    // ---- Step 5: Verify ----
    step5: {
      successTitle: "You're All Set!",
      successText: 'Your module is online and connected to the server.',
      connected: 'Connected and ready',
      viewDashboard: 'View on Dashboard',
      backendUnreachable: 'Backend Server Not Reachable',
      backendUnreachableText:
        'The server is not responding. Make sure it is running before continuing.',
      retryHealth: 'Check Again',
      timeoutTitle: 'Module Not Detected Yet',
      timeoutText: "We couldn't find your module on the server. Here are a few things to check:",
      waitingTitle: 'Waiting for Your Module...',
      waitingText:
        'Your module is restarting and connecting to the server. This usually takes about 30 seconds.',
      checking: 'Checking for your module',
      starting: 'Starting...',
      goBackConfig: 'Go back to configuration',
      wifiReminder:
        'Make sure your device is connected to your home WiFi, not the HiveHive-Access-Point.',
      troubleshoot: {
        powerTitle: 'Is the module powered on?',
        powerText:
          'Make sure the ESP32-CAM has power (USB or battery) and the LED blinks on startup.',
        wifiTitle: 'Did it connect to your WiFi?',
        wifiText:
          "Check your router's connected devices list. If the module isn't there, reconfigure it \u2014 the WiFi credentials may be incorrect.",
        apTitle: 'Is the access point still visible?',
        apText:
          "If you can still see 'HiveHive-Access-Point' in your WiFi list, the module hasn't connected to your home network yet. Reconnect and verify the WiFi settings.",
        resetTitle: 'Factory Reset',
        resetText:
          'Hold the left button on the ESP32-CAM for 10+ seconds until it restarts. This resets all settings and re-opens the configuration portal.',
      },
    },

    // ---- Error Boundary ----
    errorBoundary: {
      title: 'Something went wrong',
    },
  },

  de: {
    // ---- Common ----
    common: {
      back: 'Zur\u00FCck',
      next: 'Weiter',
      online: 'Online',
      offline: 'Offline',
      loading: 'Laden...',
      error: 'Fehler',
      tryAgain: 'Erneut versuchen',
      copy: 'Kopieren',
      copied: 'Kopiert!',
      reloadPage: 'Seite neu laden',
      impressum: 'Impressum',
      hiveModules: 'Hive Module',
      backToHome: 'Zur Startseite',
    },

    // ---- Home Page ----
    home: {
      heroSubtitle: '/ha\u026Av/ /ha\u026Av/',
      heroText:
        'Wir glauben, dass Wildbienen ein untersch\u00E4tzter Biomarker f\u00FCr die Gesundheit unserer Umwelt sind. Unsere Mission ist es, diese Informationen f\u00FCr alle zug\u00E4nglich und nutzbar zu machen.',
      viewDashboard: 'Zum Dashboard',
      howItWorks: 'So funktioniert\u2019s',
      getStartedTitle: 'In 3 Schritten starten',
      step1Title: 'Hive-Modul besorgen',
      step1Text:
        'Bestelle vorgefertigte Holzteile, lade CAD-Dateien zum Selbstlasern herunter und sieh, welche Elektronik du brauchst.',
      step1Cta: 'Das Hive-Modul \u2192',
      step2Title: 'Flashen & Einrichten',
      step2Text:
        'Verbinde deine ESP32-CAM mit dem Computer und nutze unseren Installer, um die Firmware zu flashen.',
      step2GuidedTitle: '\uD83D\uDCE1 Gef\u00FChrtes Setup',
      step2GuidedText:
        'Unser Setup-Assistent f\u00FChrt dich Schritt f\u00FCr Schritt durch Flashen, Konfigurieren und Verbinden deines Moduls',
      step2Cta: 'Setup starten \u2192',
      step3Title: 'Entdecken & Beitragen',
      step3Text:
        'Richte dein Hive-Modul ein, beobachte Wildbienen-Populationen und trage wertvolle Daten bei, um die Best\u00E4uber-Gesundheit in deiner Region zu verstehen.',
      step3Community:
        '\u2728 Werde Teil einer Gemeinschaft von B\u00FCrgerwissenschaftlern, die einen echten Unterschied machen. Perfekt f\u00FCr Naturbegeisterte, Forschende, Entscheidungstr\u00E4ger, P\u00E4dagogen, Landwirtschaftsprofis und alle, die an Biomarker-Daten interessiert sind.',
      step3Cta: 'Dashboard erkunden \u2192',
      footer: 'Gemacht mit \uD83D\uDC9B f\u00FCr Wildbienen \u00FCberall',
    },

    // ---- Dashboard ----
    dashboard: {
      title: 'Dashboard',
      modulesInView: '{count} Module sichtbar',
      inViewTap: '{count} sichtbar \u2022 Antippen zum \u00D6ffnen',
      moduleDetails: 'Moduldetails',
      errorTitle: 'Es liegt nicht an dir, es liegt an uns!',
      errorSubtitle: 'Unsere Arbeitsbienen sind bereits dran.',
      errorDetail:
        'Module konnten nicht geladen werden. Stelle sicher, dass das Backend l\u00E4uft.',
      loadingMap: 'Karte wird geladen...',
      onlineCount: '{online}/{total}',
      statusOnline: '\u25CF Online',
      statusOffline: '\u25CB Offline',
    },

    // ---- Module Panel ----
    modulePanel: {
      lastUpdate: 'Letztes Update: {time}',
      hatches: 'Schl\u00FCpfungen',
      images: 'Bilder',
      nest: 'Nest {index}',
      moduleNotFound: 'Modul nicht gefunden',
      failedToLoad: 'Moduldetails konnten nicht geladen werden',
    },

    // ---- Admin key (telemetry gate) ----
    adminKey: {
      telemetry: 'Telemetrie',
      formLabel: 'Admin-Schlüssel eingeben',
      label: 'Admin-Schlüssel',
      placeholder: 'Admin-Schlüssel eingeben',
      unlock: 'Entsperren',
      cancel: 'Abbrechen',
      forget: 'Admin-Schlüssel vergessen',
      refresh: 'Aktualisieren',
      invalid: 'Ungültiger Schlüssel. Bitte erneut versuchen.',
      loading: 'Telemetrie wird geladen…',
      loadFailed: 'Telemetrie konnte nicht geladen werden.',
      empty: 'Noch keine Telemetrie. Logs werden mit jedem hochgeladenen Bild gesendet.',
    },

    // ---- Hive Module Page ----
    hiveModule: {
      pageTitle: 'Hive-Modul',
      heroTitle: 'Das Hive-Modul',
      heroText:
        'Eine standardisierte Bienen-Niststruktur mit integriertem Kamerasystem. \u00DCberwache Wildbienenaktivit\u00E4t und trage zur Biodiversit\u00E4tsforschung bei.',
      orderTitle: 'Holzteile bestellen',
      orderText:
        'Vorgeschnittene, lasergravierte Niststruktur aus Holz. Sofort montagebereit \u2014 nur die Elektronik fehlt noch.',
      orderCta: 'Jetzt bestellen',
      comingSoon: 'Bald verf\u00FCgbar',
      diyTitle: 'Selbst lasern',
      diyText:
        'Lade die FreeCAD-Designdatei herunter und schneide die Teile auf deinem eigenen Lasercutter oder im lokalen Makerspace.',
      diyCta: 'CAD-Datei herunterladen (.FCStd)',
      electronicsTitle: 'Ben\u00F6tigte Elektronik',
      electronicsSubtitle:
        'Diese Teile sind bei Amazon, AliExpress oder deinem lokalen Elektronikladen erh\u00E4ltlich.',
      toolsTitle: 'Ben\u00F6tigtes Werkzeug',
      toolsSubtitle: 'Ein paar grundlegende Werkzeuge f\u00FCr Montage und Verkabelung.',
      tool: 'Werkzeug',
      purpose: 'Verwendung',
      estimatedTotal: 'Gesch\u00E4tzter Gesamtpreis',
      component: 'Bauteil',
      description: 'Beschreibung',
      estPrice: 'Ca. Preis',
      ctaTitle: 'Alles beisammen?',
      ctaText:
        'Folge unserer Schritt-f\u00FCr-Schritt-Anleitung, um die Holzstruktur zusammenzubauen und die Elektronik zu verdrahten.',
      ctaCta: 'Hive-Modul zusammenbauen',
      // Parts
      esp32cam: 'ESP32-CAM',
      esp32camDesc: 'Mikrocontroller mit integriertem Kameramodul',
      pvModule: 'PV-Modul',
      pvModuleDesc: '10 Wp Mono 12 V Solarpanel',
      chargeController: 'Laderegler',
      chargeControllerDesc: 'CN3791 MPPT Einzelzellen-Modul',
      batteryPack: 'Akkupack',
      batteryPackDesc: '2 \u00D7 LiFePO\u2084 3,2 V, 3\u20134 Ah',
      bms: 'BMS',
      bmsDesc: '1S LiFePO\u2084 BMS mit Temperaturabschaltung',
      boostConverter: 'Spannungswandler',
      boostConverterDesc: 'MT3608 3,2 V \u2192 5 V Modul',
      // Tools
      solderingIron: 'L\u00F6tkolben',
      solderingIronDetail:
        'F\u00FCr die Verkabelung des Stromsystems und der ESP32-CAM-Verbindungen',
      doubleSidedTape: 'Doppelseitiges Klebeband',
      doubleSidedTapeDetail: 'Zum Befestigen der ESP32-CAM und Sichern von Komponenten im Modul',
      smallScrewdriver: 'Kleiner Schraubendreher',
      smallScrewdriverDetail:
        'Kreuzschlitz zum Festziehen von Klemmenbl\u00F6cken und Befestigungsschrauben',
    },

    // ---- Assembly Guide ----
    assembly: {
      pageTitle: 'Montageanleitung',
      backToModule: 'Zur\u00FCck zum Hive-Modul',
      heroTitle: 'Baue dein Hive-Modul zusammen',
      heroSubtitle:
        'Folge diesen Schritten, um dein Modul aus lasergeschnittenen Holzteilen und Elektronik zusammenzubauen. Dauert ca. 30\u201360 Minuten.',
      photoStep: 'Foto: Schritt {n}',
      tips: 'Tipps',
      factoryReset:
        'Wenn du dein Modul neu konfigurieren musst, halte den linken Knopf der ESP32-CAM 10+ Sekunden gedr\u00FCckt. Es startet neu und \u00F6ffnet das WLAN-Konfigurationsportal erneut.',
      factoryResetLabel: 'Werkseinstellungen:',
      ctaTitle: 'Modul zusammengebaut?',
      ctaText: 'Jetzt die Firmware flashen und dein Modul mit dem Server verbinden.',
      ctaCta: 'Setup-Assistent starten',
      steps: [
        {
          title: 'Holzteile vorbereiten',
          description:
            'Lege alle lasergeschnittenen Holzteile aus. Identifiziere die Grundplatte, Seitenw\u00E4nde, Innentrennw\u00E4nde und die Kapselwand. Entferne ggf. Schutzfolie und schleife die Kanten bei Bedarf leicht ab.',
          tips: [
            'Vergleiche alle Teile mit der CAD-Zeichnung, bevor du beginnst',
            'Beschrifte jedes Teil mit Bleistift, wenn du unsicher \u00FCber die Platzierung bist',
          ],
        },
        {
          title: 'Rahmen zusammenbauen',
          description:
            'Klebe oder stecke die Seitenw\u00E4nde in die Grundplatte. Bringe die Innentrennw\u00E4nde an, um vier F\u00E4cher nach Nestgr\u00F6\u00DFe zu erstellen. Jedes Fach h\u00E4lt vier Nistr\u00F6hren.',
          tips: [
            'Verwende Holzleim f\u00FCr dauerhafte Verbindung oder Steckverbindung f\u00FCr einen demontierbaren Prototyp',
            'Stelle sicher, dass die Trennw\u00E4nde b\u00FCndig sitzen \u2014 die Kamera braucht freie Sicht auf alle L\u00F6cher',
          ],
        },
        {
          title: 'Nistr\u00F6hren einsetzen',
          description:
            'Schiebe die Nistr\u00F6hren in jedes Fach. Das Modul unterst\u00FCtzt vier Nestgr\u00F6\u00DFen mit je vier R\u00F6hren (16 R\u00F6hren insgesamt): 2 mm, 3 mm, 6 mm und 9 mm.',
          tips: [
            'Verwende R\u00F6hren mit dem richtigen Durchmesser f\u00FCr jeden Artenabschnitt',
            'Schiebe die R\u00F6hren bis zur Vorderseite des Moduls b\u00FCndig ein',
          ],
        },
        {
          title: 'Kapselwand anbringen',
          description:
            'Montiere die Kapselwand (Frontabdeckung) auf den Rahmen. Dieses Teil enth\u00E4lt das Kamerafenster und sch\u00FCtzt das Elektronikfach. Richte es sorgf\u00E4ltig aus, bevor du es befestigst.',
          tips: [
            'Die Kamera\u00F6ffnung sollte mittig auf dem Nistr\u00F6hren-Raster sitzen',
            'Lasse die Kapselwand abnehmbar f\u00FCr Wartungszwecke',
          ],
        },
        {
          title: 'Stromsystem verdrahten',
          description:
            'Verbinde die Elektronik in dieser Reihenfolge: Solarpanel \u2192 CN3791-Laderegler \u2192 LiFePO\u2084-Akkus (via BMS) \u2192 MT3608-Spannungswandler. Stelle den Spannungswandler auf 5 V ein, bevor du die ESP32-CAM anschlie\u00DFt.',
          tips: [
            'Pr\u00FCfe die Polarit\u00E4t bei jeder Verbindung \u2014 Verpolung besch\u00E4digt die ESP32-CAM',
            'Verwende ein Multimeter, um 5 V Ausgang des Spannungswandlers zu best\u00E4tigen, bevor du den ESP anschlie\u00DFt',
            'Sichere Kabel mit Kabelbindern oder Hei\u00DFkleber gegen lose Verbindungen',
          ],
        },
        {
          title: 'ESP32-CAM montieren',
          description:
            'Befestige die ESP32-CAM im Elektronikfach. Verbinde die 5-V- und GND-Kabel vom Spannungswandler mit den VCC- und GND-Pins der ESP32-CAM. Richte die Kameralinse auf das Kamerafenster zu den Nistr\u00F6hren aus.',
          tips: [
            'Verwende doppelseitiges Klebeband oder einen kleinen Halter, um die ESP32-CAM zu fixieren',
            'Stelle sicher, dass die Kameralinse sauber und richtig auf die R\u00F6hren fokussiert ist',
            'Lege den USB-Anschluss so, dass er f\u00FCr das erste Firmware-Flashen zug\u00E4nglich ist',
          ],
        },
        {
          title: 'Abdichten und wetterfest machen',
          description:
            'Schlie\u00DFe das Elektronikfach. Trage Silikondichtmittel um die Kabeleinf\u00FChrungen auf. Stelle sicher, dass das Kamerafenster sauber und dicht, aber nicht blockiert ist. Das Modul sollte regenfest sein, w\u00E4hrend die Nistr\u00F6hren\u00F6ffnungen f\u00FCr Bienen zug\u00E4nglich bleiben.',
          tips: [
            'Versiegle nicht die Nistr\u00F6hren\u00F6ffnungen \u2014 Bienen brauchen Zugang',
            'Lasse eine kleine Bel\u00FCftungs\u00F6ffnung, um Kondensation im Elektronikfach zu vermeiden',
            'Erw\u00E4ge einen kleinen \u00DCberstand oder ein Dach, um die Kamera vor direktem Regen zu sch\u00FCtzen',
          ],
        },
      ],
    },

    // ---- Setup Wizard ----
    setup: {
      pageTitle: 'Modul-Setup',
      stepLabels: ['Verbinden', 'Flashen', 'WLAN', 'Konfigurieren', 'Pr\u00FCfen'],
    },

    // ---- Step 1: Connect ----
    step1: {
      title: 'Modul verbinden',
      text: 'Verbinde deine ESP32-CAM \u00FCber ein USB-Kabel mit deinem Computer. Achte darauf, dass es ein Datenkabel ist, kein reines Ladekabel.',
      browserOk: 'Dein Browser unterst\u00FCtzt USB-Seriell',
      browserFail: 'Bitte verwende Chrome oder Edge zum Firmware-Flashen',
      cableTip:
        'Falls dein Ger\u00E4t sp\u00E4ter nicht erkannt wird, probiere ein anderes USB-Kabel. Manche Kabel \u00FCbertragen nur Strom, keine Daten.',
      tip: 'Tipp:',
    },

    // ---- Step 2: Flash ----
    step2: {
      title: 'Firmware flashen',
      titleDone: 'Firmware installiert!',
      text: 'Klicke auf den Button unten, um die HighFive-Firmware auf deine ESP32-CAM zu installieren.',
      textDone: 'Dein Modul ist bereit. Verbinden wir es mit deinem Netzwerk.',
      firmware: 'Firmware:',
      installBtn: 'Firmware installieren',
      skipAlreadyFlashed: '\u00DCberspringen \u2014 bereits geflasht',
      usbHintLabel: 'Was nach dem Klick passiert',
      usbHint:
        'Ein kleines Fenster fragt nach einem seriellen Port. Dein ESP32 erscheint meist als \u201EUSB Serial Device\u201C, \u201ECP2102\u201C oder \u201ECH340\u201C.',
      usbHintDetail:
        'Falls kein Ger\u00E4t angezeigt wird, probiere ein anderes USB-Kabel \u2014 manche Kabel k\u00F6nnen nur laden, nicht Daten \u00FCbertragen.',
      stateConnecting: 'Verbinde mit Ger\u00E4t...',
      statePreparing: 'Firmware wird vorbereitet...',
      stateErasing: 'Flash-Speicher wird gel\u00F6scht...',
      stateWriting: 'Firmware wird geschrieben...',
      stateFinished: 'Firmware erfolgreich installiert!',
      stateError: 'Flashen fehlgeschlagen. Bitte versuche es erneut.',
      errorHint:
        'Stelle sicher, dass das Ger\u00E4t verbunden ist, und probiere ggf. ein anderes USB-Kabel.',
      markComplete: 'Flash erfolgreich? Hier klicken zum Fortfahren',
      unplugTitle: 'Jetzt den ESP32 ab- und wieder anstecken',
      unplugStep1: 'Ziehe das USB-Kabel vom ESP32 ab',
      unplugStep2: 'Warte ca. 5 Sekunden',
      unplugStep3: 'Stecke es wieder ein \u2014 das Modul startet mit der neuen Firmware neu',
    },

    // ---- Step 3: WiFi ----
    step3: {
      title: 'Mit deinem Modul verbinden',
      text: 'Dein Modul sendet jetzt sein eigenes WLAN-Netzwerk. \u00D6ffne deine Ger\u00E4te-WLAN-Einstellungen und verbinde dich damit.',
      networkName: 'Netzwerkname',
      openNetwork: 'Dies ist ein offenes Netzwerk \u2014 kein Passwort n\u00F6tig.',
      disconnectNotice:
        'Deine Internetverbindung wird vor\u00FCbergehend unterbrochen, wenn du dich mit dem Modul-Netzwerk verbindest. Das ist v\u00F6llig normal.',
      connected: 'Ich bin verbunden',
      cantSeeNetwork: 'Netzwerk nicht sichtbar?',
      troubleshoot: {
        resetTitle: 'Reset-Taste dr\u00FCcken',
        resetText:
          'Dr\u00FCcke die kleine Reset-Taste auf dem ESP32-CAM-Board. Warte 10 Sekunden, bis das Netzwerk erscheint.',
        waitTitle: 'Etwas mehr Geduld',
        waitText:
          'Manche Boards brauchen bis zu 30 Sekunden, um den Access Point nach einem frischen Flash zu starten.',
        reflashTitle: 'Zur\u00FCck und erneut flashen',
        reflashText:
          'Falls nichts hilft, gehe zur\u00FCck und flashe die Firmware erneut. Stelle sicher, dass 100% Fortschritt angezeigt wird.',
      },
    },

    // ---- Step 4: Configure ----
    step4: {
      title: 'Modul konfigurieren',
      text: 'Gib deine WLAN-Daten ein, damit sich dein Modul mit dem Internet verbinden kann.',
      moduleName: 'Modulname',
      moduleNamePlaceholder: 'z.B. Garten-Hive',
      wifiNetwork: 'WLAN-Netzwerk (SSID)',
      wifiPlaceholder: 'Dein WLAN-Name',
      wifiPassword: 'WLAN-Passwort',
      wifiPasswordPlaceholder: 'Dein WLAN-Passwort',
      saveBtn: 'Konfiguration speichern',
      sending: 'Modul wird konfiguriert...',
      error: 'Modul nicht erreichbar.',
      errorHint: 'Stelle sicher, dass du mit dem HiveHive-Access-Point WLAN verbunden bist.',
      reconnectTitle: 'Konfiguration gespeichert!',
      reconnectText:
        'Dein Modul hat die Einstellungen gespeichert und startet neu. Wechsle jetzt zur\u00FCck zu deinem Heim-WLAN.',
      reconnectWifiLabel: 'WLAN jetzt wechseln:',
      reconnectStep1: '\u00D6ffne deine WLAN-Einstellungen',
      reconnectStep2: 'Trenne die Verbindung zum HiveHive-Access-Point',
      reconnectStep3: 'Verbinde dich mit deinem Heim-WLAN',
      reconnectBtn: 'Ich bin in meinem Heim-WLAN',
    },

    // ---- Step 5: Verify ----
    step5: {
      successTitle: 'Alles fertig!',
      successText: 'Dein Modul ist online und mit dem Server verbunden.',
      connected: 'Verbunden und bereit',
      viewDashboard: 'Im Dashboard anzeigen',
      backendUnreachable: 'Backend-Server nicht erreichbar',
      backendUnreachableText:
        'Der Server antwortet nicht. Stelle sicher, dass er l\u00E4uft, bevor du fortf\u00E4hrst.',
      retryHealth: 'Erneut pr\u00FCfen',
      timeoutTitle: 'Modul noch nicht erkannt',
      timeoutText:
        'Wir konnten dein Modul nicht auf dem Server finden. Hier ein paar Dinge zum Pr\u00FCfen:',
      waitingTitle: 'Warte auf dein Modul...',
      waitingText:
        'Dein Modul startet neu und verbindet sich mit dem Server. Das dauert normalerweise ca. 30 Sekunden.',
      checking: 'Suche nach deinem Modul',
      starting: 'Starte...',
      goBackConfig: 'Zur\u00FCck zur Konfiguration',
      wifiReminder:
        'Stelle sicher, dass dein Ger\u00E4t mit deinem Heim-WLAN verbunden ist, nicht mit dem HiveHive-Access-Point.',
      troubleshoot: {
        powerTitle: 'Ist das Modul eingeschaltet?',
        powerText:
          'Stelle sicher, dass die ESP32-CAM Strom hat (USB oder Akku) und die LED beim Start blinkt.',
        wifiTitle: 'Hat es sich mit deinem WLAN verbunden?',
        wifiText:
          'Pr\u00FCfe die Liste der verbundenen Ger\u00E4te deines Routers. Wenn das Modul nicht aufgelistet ist, konfiguriere es neu \u2014 die WLAN-Zugangsdaten sind m\u00F6glicherweise falsch.',
        apTitle: 'Ist der Access Point noch sichtbar?',
        apText:
          "Wenn du 'HiveHive-Access-Point' noch in deiner WLAN-Liste siehst, hat sich das Modul noch nicht mit deinem Heimnetzwerk verbunden. Verbinde dich erneut und \u00FCberpr\u00FCfe die WLAN-Einstellungen.",
        resetTitle: 'Werkseinstellungen',
        resetText:
          'Halte den linken Knopf der ESP32-CAM 10+ Sekunden gedr\u00FCckt, bis sie neu startet. Dies setzt alle Einstellungen zur\u00FCck und \u00F6ffnet das Konfigurationsportal erneut.',
      },
    },

    // ---- Error Boundary ----
    errorBoundary: {
      title: 'Etwas ist schiefgelaufen',
    },
  },
} as const;

export type Language = keyof typeof translations;
export type TranslationKeys = typeof translations.en;
export default translations;
