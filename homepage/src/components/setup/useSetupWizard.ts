import { useState, useCallback, useRef, useEffect } from 'react';
import { api, Module } from '../../services/api';
import { sendConfigToEsp } from './espConfig';

export interface WizardState {
  currentStep: number;
  direction: 'forward' | 'back';
  // Step 2
  firmwareUrl: string;
  firmwareVersion: string;
  firmwareLoading: boolean;
  flashComplete: boolean;
  // Step 4
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

const INIT_BASE_URL = import.meta.env.VITE_INIT_BASE_URL || 'http://localhost:8000';
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
  return url
    .replace('://localhost', `://${lanIp}`)
    .replace('://127.0.0.1', `://${lanIp}`);
}

export function useSetupWizard() {
  const [state, setState] = useState<WizardState>({
    currentStep: 1,
    direction: 'forward',
    firmwareUrl: '/firmware.bin',
    firmwareVersion: '',
    firmwareLoading: true,
    flashComplete: false,
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
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const knownModuleSnapshotRef = useRef<Map<string, string | undefined>>(new Map());

  // Load firmware info, detect LAN IP, and snapshot modules on mount.
  // The module snapshot must be taken NOW (before the user configures the ESP)
  // so that when the ESP later calls /new_module, we can detect the changed
  // updated_at in the verification poll.
  useEffect(() => {
    loadFirmware();
    detectLanIp();
    snapshotModules();
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);
    };
  }, []);

  // Listen for the post-save signal from the ESP popup
  // (ESP firmware's /save handler calls window.opener.postMessage(...))
  // and auto-advance to Step 5 so the user doesn't have to navigate manually.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data === 'hivehive-config-saved') {
        setState(s => ({
          ...s,
          configSent: true,
          currentStep: Math.max(s.currentStep, 5),
          direction: 'forward',
        }));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const snapshotModules = async () => {
    try {
      const existing = await api.getAllModules();
      knownModuleSnapshotRef.current = new Map(
        existing.map((m: Module) => [m.id, m.updatedAt])
      );
      console.log('[SetupWizard] Module snapshot taken on mount:', [...knownModuleSnapshotRef.current.keys()]);
    } catch {
      // Backend might not be reachable yet (user on ESP AP) — that's fine,
      // startVerification will take a fallback snapshot.
      console.log('[SetupWizard] Could not snapshot modules on mount (backend unreachable)');
    }
  };

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
    // The locally-served /firmware.bin is the canonical build for this deploy
    // (we deliberately don't pull from GitHub Releases; the latest one there
    // predates auto-name and form-submit and would regress the wizard).
    // The sidecar /firmware.json (written by ESP32-CAM/build.sh) carries the
    // version label — releases are named after bee species (bumblebee, ...).
    let version = 'Local';
    try {
      const r = await fetch('/firmware.json', { cache: 'no-cache' });
      if (r.ok) {
        const m = await r.json();
        if (m && typeof m.version === 'string' && m.version.length > 0) {
          version = m.version;
        }
      }
    } catch {
      // manifest missing → fall back to 'Local'
    }
    setState(s => ({
      ...s,
      firmwareUrl: '/firmware.bin',
      firmwareVersion: version,
      firmwareLoading: false,
    }));
  };

  const goNext = useCallback(() => {
    setState(s => ({
      ...s,
      currentStep: Math.min(s.currentStep + 1, 5),
      direction: 'forward',
    }));
  }, []);

  const goBack = useCallback(() => {
    setState(s => ({
      ...s,
      currentStep: Math.max(s.currentStep - 1, 1),
      direction: 'back',
    }));
  }, []);

  const goToStep = useCallback((step: number) => {
    setState(s => ({
      ...s,
      currentStep: step,
      direction: step > s.currentStep ? 'forward' : 'back',
    }));
  }, []);

  const markConfigDone = useCallback(() => {
    setState(s => ({ ...s, configSent: true }));
  }, []);

  const markFlashComplete = useCallback(() => {
    setState(s => ({ ...s, flashComplete: true }));
  }, []);

  const setWifiSsid = useCallback((v: string) => {
    setState(s => ({ ...s, wifiSsid: v }));
  }, []);

  const setWifiPassword = useCallback((v: string) => {
    setState(s => ({ ...s, wifiPassword: v }));
  }, []);

  const sendConfig = useCallback(async () => {
    setState(s => ({ ...s, configSending: true, configError: null }));

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
        ssid: state.wifiSsid,
        password: state.wifiPassword,
        initBase,
        initEndpoint: SERVER_CONFIG.initEndpoint,
        uploadBase,
        uploadEndpoint: SERVER_CONFIG.uploadEndpoint,
      });
      setState(s => ({ ...s, configSending: false, configSent: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState(s => ({ ...s, configSending: false, configError: message }));
    }
  }, [state.wifiSsid, state.wifiPassword]);

  const stopVerification = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    setState(s => ({ ...s, pollingActive: false }));
  }, []);

  const startVerification = useCallback(async () => {
    console.log('[Step5] Starting verification, looking for any new module');

    // Use the snapshot taken on wizard mount so we detect any module that
    // registered/re-registered since the user opened the setup wizard.
    // Only take a fresh snapshot as fallback if the mount snapshot failed
    // (e.g., backend was unreachable when the wizard first opened).
    if (knownModuleSnapshotRef.current.size === 0) {
      try {
        const existing = await api.getAllModules();
        knownModuleSnapshotRef.current = new Map(
          existing.map((m: Module) => [m.id, m.updatedAt])
        );
        console.log('[Step5] Fallback snapshot:', [...knownModuleSnapshotRef.current.keys()]);
      } catch {
        knownModuleSnapshotRef.current = new Map();
      }
    } else {
      console.log('[Step5] Using mount snapshot:', [...knownModuleSnapshotRef.current.keys()]);
    }

    setState(s => ({
      ...s,
      pollingActive: true,
      pollCount: 0,
      verificationTimedOut: false,
      detectedModule: null,
    }));
    pollCountRef.current = 0;

    pollingIntervalRef.current = setInterval(async () => {
      pollCountRef.current++;
      setState(s => ({ ...s, pollCount: pollCountRef.current }));
      console.log(`[Step5] Poll ${pollCountRef.current}/${MAX_POLLS}`);

      if (pollCountRef.current > MAX_POLLS) {
        console.warn('[Step5] Max polls reached, timing out');
        stopVerification();
        setState(s => ({ ...s, verificationTimedOut: true }));
        return;
      }

      try {
        const modules = await api.getAllModules();
        const detectedModule = modules.find((m: Module) => {
          const prevTimestamp = knownModuleSnapshotRef.current.get(m.id);
          // New module (ID not in snapshot) OR re-registered (updatedAt changed)
          return prevTimestamp === undefined || m.updatedAt !== prevTimestamp;
        });
        if (detectedModule) {
          console.log('[Step5] New or updated module detected:', detectedModule);
          stopVerification();
          setState(s => ({ ...s, detectedModule }));
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
    goToStep,
    markConfigDone,
    markFlashComplete,
    setWifiSsid,
    setWifiPassword,
    sendConfig,
    startVerification,
    stopVerification,
    maxPolls: MAX_POLLS,
  };
}
