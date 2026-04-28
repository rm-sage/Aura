import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

function App() {
  const [status, setStatus] = useState("Aura Ready");

  const runAuraTest = async () => {
    setStatus("Loading Media...");
    try {
      // Use the exact filename from your terminal output
      // Note: We use forward slashes or escaped backslashes
      await invoke("load_video", { 
        path: "C:/Users/Smcgr/Videos/briwisswell 04-28-26 () — V[17773859359302470926] L[2049128144626612225] S[332957953].mp4" 
      });
      setStatus("Playback Active");
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err}`);
    }
  };

  return (
    <main className="h-screen w-screen flex flex-col items-center justify-center glass-panel">
      <h1 className="text-white text-2xl font-light mb-8 tracking-widest uppercase">Aura Engine Test</h1>
      <button 
        onClick={runAuraTest}
        className="px-8 py-4 bg-white/10 hover:bg-white/20 border border-white/20 rounded-full text-white backdrop-blur-xl transition-all active:scale-95"
      >
        Play Latest Recording
      </button>
      <p className="mt-4 text-white/50 font-mono text-sm">{status}</p>
    </main>
  );
}

export default App;