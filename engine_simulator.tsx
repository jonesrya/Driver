import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Play, Square, Settings, Upload, MapPin, 
  Car, Activity, Volume2, RotateCcw, X
} from 'lucide-react';

const DEFAULTS = {
  idleInterval: 0.85,
  maxMph: 80.0,
  maxVolume: 1.0,
  sensitivity: 1.0,
  baselineRpm: 1.0,
};

const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371000; // Radius of the Earth in meters
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

export default function EngineSimulatorApp() {
  const [config, setConfig] = useState(DEFAULTS);
  const [activeTab, setActiveTab] = useState('sim'); // 'sim' | 'gps'
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [audioLoaded, setAudioLoaded] = useState(false);
  const [fileName, setFileName] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  // Dashboard Stats
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [dashStats, setDashStats] = useState({
    effectiveSpeed: 0,
    firingRate: 0,
    pitch: 1.0,
    curveFactor: 0
  });

  // Refs for Audio & Loops
  const audioCtxRef = useRef(null);
  const audioBufferRef = useRef(null);
  const loopTimeoutRef = useRef(null);
  const isRunningRef = useRef(false); 
  const speedRef = useRef(0);
  
  // Refs for GPS
  const watchIdRef = useRef(null);
  const prevLocationRef = useRef(null);
  const prevTimeRef = useRef(null);

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    setFileName(file.name);
    setErrorMsg("");
    setAudioLoaded(false);

    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      
      const arrayBuffer = await file.arrayBuffer();
      const decodedBuffer = await audioCtxRef.current.decodeAudioData(arrayBuffer);
      
      audioBufferRef.current = decodedBuffer;
      setAudioLoaded(true);
    } catch (err) {
      console.error(err);
      setErrorMsg("Failed to decode audio. Please ensure it's a valid format (e.g., .wav, .mp3).");
    }
  };

  const engineLoop = useCallback(() => {
    if (!isRunningRef.current || !audioCtxRef.current || !audioBufferRef.current) return;

    const speed = speedRef.current;
    
    // Core math from Python script
    let effectiveSpeed = Math.max(0.0, Math.min(config.maxMph, speed * config.sensitivity));
    let speedFraction = effectiveSpeed / config.maxMph;
    let curveFactor = Math.pow(speedFraction, 0.5);

    let spawnInterval = config.idleInterval - (curveFactor * (config.idleInterval - 0.05));
    let targetVolume = Math.min(config.maxVolume, 0.20 + (curveFactor * 0.80));
    let targetPitch = config.baselineRpm + (curveFactor * 1.0);

    // Update UI Stats
    setDashStats({
      effectiveSpeed,
      firingRate: 1.0 / spawnInterval,
      pitch: targetPitch,
      curveFactor
    });

    // Fire audio blast
    try {
      const source = audioCtxRef.current.createBufferSource();
      source.buffer = audioBufferRef.current;
      source.playbackRate.value = targetPitch;

      const gainNode = audioCtxRef.current.createGain();
      gainNode.gain.value = targetVolume;

      source.connect(gainNode);
      gainNode.connect(audioCtxRef.current.destination);
      source.start();
    } catch (err) {
      console.warn("Audio playback interrupted", err);
    }

    loopTimeoutRef.current = setTimeout(engineLoop, spawnInterval * 1000);
  }, [config]);

  const toggleEngine = async () => {
    if (!audioLoaded) {
      setErrorMsg("Please load an audio file first.");
      return;
    }

    if (!isRunning) {
      // Start Engine
      if (audioCtxRef.current?.state === 'suspended') {
        await audioCtxRef.current.resume();
      }
      
      setIsRunning(true);
      isRunningRef.current = true;
      setErrorMsg("");

      if (activeTab === 'gps') {
        startGPS();
      }

      engineLoop();
    } else {
      // Stop Engine
      setIsRunning(false);
      isRunningRef.current = false;
      if (loopTimeoutRef.current) clearTimeout(loopTimeoutRef.current);
      stopGPS();
      setDashStats({ effectiveSpeed: 0, firingRate: 0, pitch: config.baselineRpm, curveFactor: 0 });
    }
  };

  const startGPS = () => {
    if (!("geolocation" in navigator)) {
      setErrorMsg("Geolocation is not supported by your browser.");
      setActiveTab('sim');
      return;
    }

    prevLocationRef.current = null;
    prevTimeRef.current = null;

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const currentTime = Date.now() / 1000;
        let newSpeedMph = 0.0;

        if (position.coords.speed !== null && position.coords.speed >= 0) {
          newSpeedMph = position.coords.speed * 2.23694;
        } else if (prevLocationRef.current && prevTimeRef.current) {
          const timeDelta = currentTime - prevTimeRef.current;
          if (timeDelta > 0) {
            const dist = haversineDistance(
              prevLocationRef.current.latitude, prevLocationRef.current.longitude,
              position.coords.latitude, position.coords.longitude
            );
            let speedMps = dist / timeDelta;
            if (dist < 1.0) speedMps = 0.0; // Noise reduction
            newSpeedMph = speedMps * 2.23694;
          }
        }

        speedRef.current = newSpeedMph;
        setCurrentSpeed(newSpeedMph);
        
        prevLocationRef.current = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        };
        prevTimeRef.current = currentTime;
      },
      (err) => {
        console.error("GPS Error", err);
        setErrorMsg("GPS Error: Could not determine location.");
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
    );
  };

  const stopGPS = () => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      isRunningRef.current = false;
      if (loopTimeoutRef.current) clearTimeout(loopTimeoutRef.current);
      stopGPS();
    };
  }, []);

  useEffect(() => {
    if (activeTab === 'sim' && isRunning) {
      stopGPS();
    } else if (activeTab === 'gps' && isRunning) {
      startGPS();
    }
  }, [activeTab, isRunning]);

  const handleSimSpeedChange = (e) => {
    const val = parseFloat(e.target.value);
    speedRef.current = val;
    setCurrentSpeed(val);
  };

  const gaugeRotation = -135 + (dashStats.curveFactor * 270);
  
  return (
    <div className="min-h-screen bg-black text-slate-100 font-sans selection:bg-blue-500/30 pb-20">
      {/* Background gradients for premium feel */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/20 rounded-full blur-[100px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-600/20 rounded-full blur-[100px]" />
      </div>

      <div className="max-w-md mx-auto p-4 sm:p-6 relative z-10 flex flex-col gap-6">
        
        {/* Header */}
        <header className="flex justify-between items-center pt-4">
          <div>
            <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">
              Engine Dynamics
            </h1>
            <p className="text-xs text-slate-400 font-medium tracking-wide uppercase mt-1">Acoustic Simulator</p>
          </div>
          <button 
            onClick={() => setIsSettingsOpen(true)}
            className="p-2.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 transition-colors backdrop-blur-md"
          >
            <Settings size={20} className="text-slate-300" />
          </button>
        </header>

        {}
        <div className="bg-white/[0.03] backdrop-blur-xl border border-white/10 rounded-3xl p-5 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
              <Volume2 size={16} /> Audio Source
            </h2>
            {audioLoaded && <span className="text-xs font-medium text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-full">Ready</span>}
          </div>
          
          <label className="flex items-center justify-center w-full h-14 px-4 transition bg-white/5 border-2 border-dashed border-white/20 rounded-2xl appearance-none cursor-pointer hover:border-white/40 focus:outline-none">
            <span className="flex items-center space-x-2">
              <Upload size={18} className="text-slate-400" />
              <span className="font-medium text-slate-300 text-sm">
                {fileName ? fileName : 'Select .wav / .mp3'}
              </span>
            </span>
            <input type="file" name="file_upload" className="hidden" accept="audio/*" onChange={handleFileUpload} />
          </label>
        </div>

        {}
        <div className="bg-white/[0.03] backdrop-blur-xl border border-white/10 rounded-3xl p-6 shadow-2xl relative overflow-hidden">
          
          <div className="relative w-48 h-48 mx-auto">
            {/* Background Track */}
            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="40" fill="transparent" stroke="rgba(255,255,255,0.1)" strokeWidth="10" strokeDasharray="188.5" strokeDashoffset="0" strokeLinecap="round" />
            </svg>
            {/* Active Track */}
            <svg className="w-full h-full transform -rotate-90 absolute inset-0" viewBox="0 0 100 100">
              <circle 
                cx="50" cy="50" r="40" fill="transparent" stroke="currentColor" strokeWidth="10" 
                strokeDasharray="251.2" 
                strokeDashoffset={251.2 - (251.2 * 0.75 * dashStats.curveFactor)} 
                strokeLinecap="round"
                className="text-blue-500 transition-all duration-150 ease-out"
                style={{ transformOrigin: 'center', transform: 'rotate(-45deg)' }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-4xl font-bold tracking-tighter">{currentSpeed.toFixed(0)}</span>
              <span className="text-xs text-slate-400 font-medium mt-1">MPH</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mt-6">
            <div className="bg-black/30 rounded-2xl p-3 text-center border border-white/5">
              <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-1 font-semibold flex items-center justify-center gap-1">
                 <Activity size={12} /> Firing Rate
              </div>
              <div className="text-lg font-bold text-slate-200">{dashStats.firingRate.toFixed(1)} <span className="text-xs font-normal text-slate-500">/s</span></div>
            </div>
            <div className="bg-black/30 rounded-2xl p-3 text-center border border-white/5">
              <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-1 font-semibold flex items-center justify-center gap-1">
                Pitch RPM
              </div>
              <div className="text-lg font-bold text-blue-400">{dashStats.pitch.toFixed(2)}x</div>
            </div>
          </div>
        </div>

        {}
        <div className="bg-white/[0.03] backdrop-blur-xl border border-white/10 rounded-3xl p-2 shadow-2xl">
          <div className="flex bg-black/40 p-1 rounded-2xl mb-4">
            <button 
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center justify-center gap-2 ${activeTab === 'sim' ? 'bg-white/10 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
              onClick={() => { setActiveTab('sim'); setCurrentSpeed(0); speedRef.current = 0; }}
            >
              <Car size={16} /> Simulator
            </button>
            <button 
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-all flex items-center justify-center gap-2 ${activeTab === 'gps' ? 'bg-white/10 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
              onClick={() => setActiveTab('gps')}
            >
              <MapPin size={16} /> Live GPS
            </button>
          </div>

          <div className="px-3 pb-3">
            {activeTab === 'sim' && (
              <div className="mb-6">
                <div className="flex justify-between mb-2">
                  <span className="text-xs font-semibold text-slate-400">Manual Throttle</span>
                  <span className="text-xs font-bold text-white">{currentSpeed.toFixed(1)} MPH</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max={config.maxMph} 
                  step="0.5" 
                  value={currentSpeed}
                  onChange={handleSimSpeedChange}
                  className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
              </div>
            )}

            {activeTab === 'gps' && (
              <div className="mb-6 text-center bg-blue-500/10 border border-blue-500/20 rounded-xl p-3">
                <p className="text-xs text-blue-300 font-medium">GPS Tracking Active. Drive safely.</p>
              </div>
            )}

            {errorMsg && (
              <div className="mb-4 text-center bg-red-500/10 border border-red-500/20 text-red-400 text-xs py-2 px-3 rounded-lg font-medium">
                {errorMsg}
              </div>
            )}

            <button 
              onClick={toggleEngine}
              disabled={!audioLoaded}
              className={`w-full py-4 rounded-2xl font-bold text-sm tracking-wide transition-all flex items-center justify-center gap-2 ${
                !audioLoaded ? 'bg-white/5 text-slate-500 cursor-not-allowed' :
                isRunning ? 'bg-red-500/20 text-red-500 hover:bg-red-500/30 border border-red-500/30' : 
                'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30'
              }`}
            >
              {isRunning ? <><Square size={18} fill="currentColor" /> STOP ENGINE</> : <><Play size={18} fill="currentColor" /> START ENGINE</>}
            </button>
          </div>
        </div>
      </div>

      {}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-sm bg-[#1c1c1e] border border-white/10 rounded-[2.5rem] p-6 shadow-2xl relative animate-in slide-in-from-bottom-8 duration-300">
            <button 
              onClick={() => setIsSettingsOpen(false)}
              className="absolute top-6 right-6 p-2 bg-white/5 rounded-full hover:bg-white/10 transition-colors"
            >
              <X size={18} className="text-slate-400" />
            </button>
            
            <h2 className="text-xl font-bold mb-6 text-white">Engine Tuning</h2>
            
            <div className="space-y-6">
              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm font-medium text-slate-300">Sensitivity Multiplier</label>
                  <span className="text-sm font-bold text-blue-400">{config.sensitivity.toFixed(1)}x</span>
                </div>
                <input 
                  type="range" min="0.1" max="5.0" step="0.1" value={config.sensitivity}
                  onChange={(e) => setConfig({...config, sensitivity: parseFloat(e.target.value)})}
                  className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <p className="text-[10px] text-slate-500 mt-1.5">Scales the input speed artificially.</p>
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm font-medium text-slate-300">Baseline Pitch RPM</label>
                  <span className="text-sm font-bold text-blue-400">{config.baselineRpm.toFixed(1)}x</span>
                </div>
                <input 
                  type="range" min="0.1" max="3.0" step="0.1" value={config.baselineRpm}
                  onChange={(e) => setConfig({...config, baselineRpm: parseFloat(e.target.value)})}
                  className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <p className="text-[10px] text-slate-500 mt-1.5">Starting point for audio playback rate.</p>
              </div>

              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm font-medium text-slate-300">Max Freeway Speed</label>
                  <span className="text-sm font-bold text-blue-400">{config.maxMph.toFixed(0)} MPH</span>
                </div>
                <input 
                  type="range" min="20" max="200" step="5" value={config.maxMph}
                  onChange={(e) => setConfig({...config, maxMph: parseFloat(e.target.value)})}
                  className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <p className="text-[10px] text-slate-500 mt-1.5">Boundary capping the engine sound curve.</p>
              </div>
              
              <div className="pt-4 border-t border-white/10">
                <button 
                  onClick={() => setConfig(DEFAULTS)}
                  className="w-full py-3 bg-white/5 hover:bg-white/10 rounded-2xl text-sm font-semibold text-slate-300 flex items-center justify-center gap-2 transition-colors"
                >
                  <RotateCcw size={16} /> Restore Defaults
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}