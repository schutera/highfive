import { useState, useCallback, useRef, useEffect } from 'react';
import { api } from '../../services/api';
import type { Module } from '@highfive/contracts';
import { sendConfigToEsp } from './espConfig';
// Vite-managed firmware asset (content-hashed) used both as the local
// fallback URL when the GitHub releases API is unreachable and as the
// canonical path for esptool-js inside Step 2.
import firmwareUrl from '../../assets/firmware.bin?url';

export interface WizardState {
  currentStep: number;
  direction: 'forward' | 'back';
  // Step 2
  firmwareUrl: string;
  firmwareVersion: string;
  firmwareLoading: boolean;
  flashComplete: boolean;
  // Step 4
  moduleName: string;
  wifiSsid: string;
  wifiPassword: string;
  configSending: boolean;
  configSent: boolean;
  configError: string | null;
  // Step 5
  pollingActive: boolean;
  pollCount: number;
  detectedModule: Module | null;
  verificationTimedOut: boolean;
}

const INIT_BASE_URL = import.meta.env.VITE_INIT_BASE_URL || 'http://localhost:8002';
const UPLOAD_BASE_URL = import.meta.env.VITE_UPLOAD_BASE_URL || 'http://localhost:8000';

export const SERVER_CONFIG = {
  initBaseUrl: INIT_BASE_URL,
  initEndpoint: '/new_module',
  uploadBaseUrl: UPLOAD_BASE_URL,
  uploadEndpoint: '/upload',
} as const;

const MAX_POLLS = 24; // 2 minutes at 5s intervals
const POLL_INTERVAL = 5000;

/**
 * Replace "localhost" or "127.0.0.1" in a URL with the given LAN IP.
 * This is needed because the ESP module can't reach "localhost" —
 * from its perspective, localhost is the ESP itself.
 */
function replaceLocalhost(url: string, lanIp: string): string {
  return url.replace('://localhost', `://${lanIp}`).replace('://127.0.0.1', `://${lanIp}`);
}

export function useSetupWizard() {
  const [state, setState] = useState<WizardState>({
    currentStep: 1,
    direction: 'forward',
    firmwareUrl: firmwareUrl,
    firmwareVersion: '',
    firmwareLoading: true,
    flashComplete: false,
    moduleName: '',
    wifiSsid: '',
    wifiPassword: '',
    configSending: false,
    configSent: false,
    configError: null,
    pollingActive: false,
    pollCount: 0,
    detectedModule: null,
    verificationTimedOut: false,
  });

  const lanIpRef = useRef<string | null>(null);
  const baselineModuleIdsRef = useRef<Set<string>>(new Set());
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);

  // Load firmware info + detect LAN IP on mount (while still on home WiFi)
  useEffect(() => {
    loadFirmware();
    detectLanIp();
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);
    };
  }, []);

  const detectLanIp = async () => {
    try {
      const resp = await fetch('/__dev-api/lan-ip');
      if (resp.ok) {
        const data = await resp.json();
        if (data.ip && data.ip !== 'localhost') {
          lanIpRef.current = data.ip;
          console.log('[SetupWizard] Detected LAN IP:', data.ip);
        }
      }
    } catch {
      // Not in dev or Vite plugin not available — that's fine
    }
  };

  const loadFirmware = async () => {
    try {
      const response = await fetch(
        'https://api.github.com/repos/schutera/highfive/releases/latest',
      );
      if (!response.ok) throw new Error('Failed to fetch release');

      const releaseData = await response.json();
      const firmwareAsset = releaseData.assets?.find(
        (asset: { name: string }) => asset.name === 'firmware.bin',
      );

      if (firmwareAsset) {
        setState((s) => ({
          ...s,
          firmwareUrl: firmwareAsset.browser_download_url,
          firmwareVersion: releaseData.tag_name || releaseData.name,
          firmwareLoading: false,
        }));
      } else {
        setState((s) => ({ ...s, firmwareVersion: 'Local', firmwareLoading: false }));
      }
    } catch {
      setState((s) => ({
        ...s,
        firmwareUrl: firmwareUrl,
        firmwareVersion: 'Local (Fallback)',
        firmwareLoading: false,
      }));
    }
  };

  const goNext = useCallback(() => {
    setState((s) => ({
      ...s,
      currentStep: Math.min(s.currentStep + 1, 5),
      direction: 'forward',
    }));
  }, []);

  const goBack = useCallback(() => {
    setState((s) => ({
      ...s,
      currentStep: Math.max(s.currentStep - 1, 1),
      direction: 'back',
    }));
  }, []);

  const markFlashComplete = useCallback(() => {
    setState((s) => ({ ...s, flashComplete: true }));
  }, []);

  const setModuleName = useCallback((v: string) => {
    setState((s) => ({ ...s, moduleName: v }));
  }, []);

  const setWifiSsid = useCallback((v: string) => {
    setState((s) => ({ ...s, wifiSsid: v }));
  }, []);

  const setWifiPassword = useCallback((v: string) => {
    setState((s) => ({ ...s, wifiPassword: v }));
  }, []);

  const sendConfig = useCallback(async () => {
    setState((s) => ({ ...s, configSending: true, configError: null }));

    // Replace localhost with LAN IP if detected
    let initBase = SERVER_CONFIG.initBaseUrl;
    let uploadBase = SERVER_CONFIG.uploadBaseUrl;
    if (lanIpRef.current) {
      initBase = replaceLocalhost(initBase, lanIpRef.current);
      uploadBase = replaceLocalhost(uploadBase, lanIpRef.current);
      console.log('[SetupWizard] Sending ESP URLs with LAN IP:', { initBase, uploadBase });
    }

    try {
      await sendConfigToEsp({
        moduleName: state.moduleName,
        ssid: state.wifiSsid,
        password: state.wifiPassword,
        initBase,
        initEndpoint: SERVER_CONFIG.initEndpoint,
        uploadBase,
        uploadEndpoint: SERVER_CONFIG.uploadEndpoint,
      });
      setState((s) => ({ ...s, configSending: false, configSent: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, configSending: false, configError: message }));
    }
  }, [state.moduleName, state.wifiSsid, state.wifiPassword]);

  const stopVerification = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    setState((s) => ({ ...s, pollingActive: false }));
  }, []);

  const startVerification = useCallback(async () => {
    // Capture baseline module list
    try {
      const currentModules = await api.getAllModules();
      baselineModuleIdsRef.current = new Set(currentModules.map((m) => m.id));
      console.log('[Step5] Baseline captured:', baselineModuleIdsRef.current.size, 'modules');
    } catch {
      console.warn('[Step5] Could not capture baseline — will retry during polling');
      baselineModuleIdsRef.current = new Set();
    }

    setState((s) => ({
      ...s,
      pollingActive: true,
      pollCount: 0,
      verificationTimedOut: false,
      detectedModule: null,
    }));
    pollCountRef.current = 0;
    let baselineCaptured = baselineModuleIdsRef.current.size > 0;

    pollingIntervalRef.current = setInterval(async () => {
      pollCountRef.current++;
      setState((s) => ({ ...s, pollCount: pollCountRef.current }));
      console.log(`[Step5] Poll ${pollCountRef.current}/${MAX_POLLS}`);

      if (pollCountRef.current > MAX_POLLS) {
        console.warn('[Step5] Max polls reached, timing out');
        stopVerification();
        setState((s) => ({ ...s, verificationTimedOut: true }));
        return;
      }

      try {
        const modules = await api.getAllModules();

        // If baseline was empty (backend wasn't reachable), capture it now
        if (!baselineCaptured && modules.length > 0) {
          baselineModuleIdsRef.current = new Set(modules.map((m) => m.id));
          baselineCaptured = true;
          console.log(
            '[Step5] Baseline captured late:',
            baselineModuleIdsRef.current.size,
            'modules',
          );
          return; // skip this poll — baseline just set
        }

        console.log(
          `[Step5] Got ${modules.length} modules, baseline has ${baselineModuleIdsRef.current.size}`,
        );
        const newModule = modules.find((m) => !baselineModuleIdsRef.current.has(m.id));
        if (newModule) {
          console.log('[Step5] New module detected:', newModule);
          stopVerification();
          setState((s) => ({ ...s, detectedModule: newModule }));
        }
      } catch (err) {
        console.error('[Step5] Poll error:', err);
      }
    }, POLL_INTERVAL);
  }, [stopVerification]);

  return {
    state,
    goNext,
    goBack,
    markFlashComplete,
    setModuleName,
    setWifiSsid,
    setWifiPassword,
    sendConfig,
    startVerification,
    stopVerification,
    maxPolls: MAX_POLLS,
  };
}
