import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LanguageProvider } from '../i18n/LanguageContext';
import Step3WiFi from '../components/setup/Step3WiFi';

// Step 3 of the setup wizard tells the user which WiFi network the module
// advertises and how to join it. The firmware AP is WPA2-protected
// (`WiFi.softAP(HOST_SSID, HOST_PASSWORD, …)` in ESP32-CAM/host.cpp), so the
// card MUST show both the SSID and the PSK. A field user once couldn't connect
// because the wizard claimed "open network — no password required" while the
// firmware demanded `esp-12345`. These assertions pin the rendered strings to
// the firmware values so that drift can't ship green again.
describe('Step3WiFi AP credentials', () => {
  // LanguageProvider reads the active locale from localStorage('lang'); clear
  // it between cases so a locale set by one test can't leak into the next.
  afterEach(() => localStorage.removeItem('lang'));

  function renderStep() {
    return render(
      <LanguageProvider>
        <Step3WiFi onNext={vi.fn()} onBack={vi.fn()} onSkip={vi.fn()} />
      </LanguageProvider>,
    );
  }

  it('renders the SSID the firmware advertises', () => {
    renderStep();
    expect(screen.getByText('ESP32-Access-Point')).toBeInTheDocument();
  });

  it('renders the WPA2 password (PSK) so the user can actually join the AP', () => {
    renderStep();
    // The literal HOST_PASSWORD from ESP32-CAM/host.cpp.
    expect(screen.getByText('esp-12345')).toBeInTheDocument();
  });

  // The original bug — a caption claiming the AP is open — shipped in BOTH the
  // en and de locales, so guard the absence of that claim in each. The PSK
  // string is locale-independent, so it must still render either way.
  it.each<[string, RegExp[]]>([
    ['en', [/no password required/i, /open network/i]],
    ['de', [/offenes Netzwerk/i, /kein Passwort/i]],
  ])('does not claim the network is open (%s locale)', (lang, patterns) => {
    localStorage.setItem('lang', lang);
    renderStep();
    for (const pattern of patterns) {
      expect(screen.queryByText(pattern)).not.toBeInTheDocument();
    }
    expect(screen.getByText('esp-12345')).toBeInTheDocument();
  });
});
