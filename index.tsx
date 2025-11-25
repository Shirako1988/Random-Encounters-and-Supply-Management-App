import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom/client';

// ==========================================
// TYPES
// ==========================================

type TerrainKey = 'road' | 'wilderness' | 'unknown' | 'enemy' | 'wanted' | 'custom';
type DayMatrixArea = 'Straße' | 'Wildnis' | 'Unbekannt' | 'Feindgebiet' | 'Gesucht' | 'Custom';
type NightMatrixArea = DayMatrixArea;

type Pace = 'normal' | 'fast' | 'slow';
type Vehicle = 'yes' | 'no';
type Vision = 'none' | 'darkvision' | 'magic';
type EncounterTypeKey = 'hostile' | 'neutral';

interface Watch {
    name: string;
    vision: Vision;
    pp: number;
}

interface Settings {
    terrain: TerrainKey;
    pace: Pace;
    vehicle: Vehicle;
    watchCount: number;
    lightHours: number;
    watches: Watch[];
}

interface EncounterRange {
    hostile: [number, number];
    neutral: [number, number];
    poi: [number, number];
}

interface NightEncounterParams {
    basis: [number, number];
    light: number;
}

interface Matrix {
    day: Record<DayMatrixArea, EncounterRange>;
    night: Record<NightMatrixArea, NightEncounterParams>;
}

type FlowStep = 
  | 'enemyStealthChoice' 
  | 'enemyStealthInput'
  | 'ppContest' 
  | 'stealthChoice'
  | 'stealthInput'
  | 'detection'
  | 'nightEncounterInfo'
  | 'nightStealthStart';

interface FlowState {
    step: FlowStep;
    context: 'day' | 'night';
    encounterType: EncounterTypeKey | 'poi';
    d: number;
    terrain: TerrainKey;
    vehicle?: boolean;
    enemyStealthAvg?: number | null;
    playerPP?: number;
    enemyPP?: number;
    winner?: 'players' | 'enemies';
    stealthAvg?: number;
    affectedWatch?: Watch;
    watchPerception?: {
        effectivePP: number;
        modifier: string;
    };
}

// --- Resource Tracking Types ---

type CreatureSize = 'Tiny' | 'Small' | 'Medium' | 'Large' | 'Huge' | 'Gargantuan';

interface Creature {
    id: string;
    name: string;
    size: CreatureSize;
    usesFeed?: boolean;
    // Survival Stats
    conMod: number;         // Constitution Modifier
    daysWithoutFood: number; // Consecutive days without full meal
    exhaustion: number;     // Level 0-6
}

type StorageType = 'food_feed' | 'water';

interface Storage {
    id: string;
    name: string;
    isActive: boolean;
    storageType: StorageType; // Determines what it can hold
    maxCapacity: number;      // Max capacity in lb (food) or gal (water)
    food: number; // in pounds
    water: number; // in gallons
    feed: number; // in units (1 unit ~ roughly 10lbs usually, but we track count)
}

interface ConsumptionRate {
    food: number; // lbs
    water: number; // gallons (base)
    feed: number; // units (relative to Large = 1)
}

// --- Modal Types ---
type ModalType = 'alert' | 'confirm';

interface ModalConfig {
    isOpen: boolean;
    type: ModalType;
    title: string;
    message: React.ReactNode;
    onConfirm?: () => void;
}


// ==========================================
// CONSTANTS
// ==========================================

const DEFAULTS: Matrix = {
  day: {
    "Straße": {hostile:[1,3], neutral:[4,6], poi:[7,8]},
    "Wildnis": {hostile:[1,5], neutral:[6,8], poi:[9,10]},
    "Unbekannt": {hostile:[1,5], neutral:[6,8], poi:[9,22]},
    "Feindgebiet": {hostile:[1,10], neutral:[11,12], poi:[13,15]},
    "Gesucht": {hostile:[1,12], neutral:[13,14], poi:[15,17]},
    "Custom": {hostile:[0,0], neutral:[0,0], poi:[0,0]}
  },
  night: {
    "Straße": {basis:[1,1], light:1},
    "Wildnis": {basis:[1,3], light:1},
    "Unbekannt": {basis:[1,3], light:1},
    "Feindgebiet": {basis:[1,6], light:1},
    "Gesucht": {basis:[1,10], light:2},
    "Custom": {basis:[0,0], light:0}
  }
};

const TERRAIN_MAP: Record<TerrainKey, DayMatrixArea> = {
    road:'Straße', 
    wilderness:'Wildnis', 
    unknown:'Unbekannt', 
    enemy:'Feindgebiet', 
    wanted:'Gesucht', 
    custom:'Custom'
};

const VISION_NAMES: Record<string, string> = {
    none:'Kein Darkvision', 
    darkvision:'Darkvision', 
    magic:'Magisches Darkvision'
};

// Anchor: Large Creature = 1 Feed Unit per day.
// Scaling based on D&D 5e food weights (x4 per size category), adapted for Feed units.
const CONSUMPTION_RATES: Record<CreatureSize, ConsumptionRate> = {
    'Tiny':       { food: 0.25, water: 0.25, feed: 0.06 }, // 1/16 of Large
    'Small':      { food: 1,    water: 1,    feed: 0.25 }, // 1/4 of Large
    'Medium':     { food: 1,    water: 1,    feed: 0.25 }, // 1/4 of Large
    'Large':      { food: 4,    water: 4,    feed: 1.0  }, // Anchor
    'Huge':       { food: 16,   water: 16,   feed: 4.0  }, // 4x Large
    'Gargantuan': { food: 64,   water: 64,   feed: 16.0 }  // 16x Large
};


// ==========================================
// HELPER FUNCTIONS
// ==========================================
const generateId = () => Math.random().toString(36).substr(2, 9);
const rnd = (n: number) => Math.floor(Math.random() * n) + 1;
const parseInts = (str: string) => str.split(/[,;\s]+/).map(x => parseInt(x, 10)).filter(x => !isNaN(x));
const avg = (arr: number[]) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
// Robust safe float parsing
const safeFloat = (val: any) => {
    const num = parseFloat(val);
    return isNaN(num) ? 0 : num;
};


// ==========================================
// COMPONENTS
// ==========================================

// --- Modal Component ---
interface ModalProps {
    config: ModalConfig;
    onClose: () => void;
}

const Modal: React.FC<ModalProps> = ({ config, onClose }) => {
    if (!config.isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-card border border-border-color rounded-xl shadow-2xl max-w-md w-full p-6 transform transition-all scale-100">
                <h3 className="text-xl font-bold mb-4 text-white">{config.title}</h3>
                <div className="text-muted mb-6 whitespace-pre-wrap text-sm leading-relaxed">
                    {config.message}
                </div>
                <div className="flex justify-end gap-3">
                    {config.type === 'confirm' && (
                        <button 
                            onClick={onClose} 
                            className="px-4 py-2 rounded-lg border border-border-color text-muted hover:bg-glass hover:text-white transition-colors"
                        >
                            Abbrechen
                        </button>
                    )}
                    <button 
                        onClick={() => {
                            if (config.onConfirm) config.onConfirm();
                            onClose();
                        }} 
                        className="px-4 py-2 rounded-lg bg-accent text-bg-secondary font-bold shadow-md hover:opacity-90 transition-opacity"
                    >
                        {config.type === 'confirm' ? 'Bestätigen' : 'OK'}
                    </button>
                </div>
            </div>
        </div>
    );
};

// --- SettingsCard ---
interface SettingsCardProps {
    settings: Settings;
    setSettings: React.Dispatch<React.SetStateAction<Settings>>;
    onTravelRoll: () => void;
    onRestRoll: () => void;
    onResetAll: () => void;
}

const SettingsCard: React.FC<SettingsCardProps> = ({ settings, setSettings, onTravelRoll, onRestRoll, onResetAll }) => {
    const handleSettingsChange = <K extends keyof Settings>(key: K, value: Settings[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    const handleWatchCountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const count = Math.max(1, Math.min(8, parseInt(e.target.value, 10) || 1));
        setSettings(prev => {
            const newWatches = [...prev.watches];
            while (newWatches.length < count) {
                newWatches.push({ name: `Wache ${newWatches.length + 1}`, vision: 'none', pp: 12 });
            }
            return {
                ...prev,
                watchCount: count,
                watches: newWatches.slice(0, count)
            };
        });
    };

    const handleWatchChange = (index: number, field: keyof Watch, value: string | number) => {
        setSettings(prev => {
            const newWatches = [...prev.watches];
            newWatches[index] = { ...newWatches[index], [field]: value };
            return { ...prev, watches: newWatches };
        });
    };

    return (
        <div className="bg-card rounded-xl p-4 shadow-lg">
            <h3 className="text-xl font-bold mb-4">Einstellungen</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className="block text-sm text-muted mb-1">Gelände / Situation</label>
                    <select value={settings.terrain} onChange={e => handleSettingsChange('terrain', e.target.value as Settings['terrain'])} className="w-full p-2 rounded-lg border border-border-color bg-input-bg text-white focus:ring-accent focus:border-accent">
                        <option value="road">Straße (zivilisiert)</option>
                        <option value="wilderness">Abseits der Straße (Wildnis)</option>
                        <option value="unknown">Unbekanntes Gebiet</option>
                        <option value="enemy">Feindgebiet</option>
                        <option value="wanted">Gesucht (hoher Fahndungsdruck)</option>
                        <option value="custom">Custom</option>
                    </select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                     <div>
                        <label className="block text-sm text-muted mb-1">Reise-Tempo</label>
                        <select value={settings.pace} onChange={e => handleSettingsChange('pace', e.target.value as Settings['pace'])} className="w-full p-2 rounded-lg border border-border-color bg-input-bg text-white">
                            <option value="normal">Normal</option>
                            <option value="fast">Schnell (Gruppen-PP halbiert)</option>
                            <option value="slow">Langsam (Gruppen-PP +50%)</option>
                        </select>
                    </div>
                     <div>
                        <label className="block text-sm text-muted mb-1">Fahrzeug?</label>
                        <select value={settings.vehicle} onChange={e => handleSettingsChange('vehicle', e.target.value as Settings['vehicle'])} className="w-full p-2 rounded-lg border border-border-color bg-input-bg text-white">
                            <option value="no">Nein</option>
                            <option value="yes">Ja (Stealth Nachteil)</option>
                        </select>
                    </div>
                </div>
            </div>

            <div className="flex gap-2 mt-4">
                <button onClick={onTravelRoll} className="flex-1 bg-gradient-to-r from-accent to-sky-500 text-bg-secondary font-bold py-2 px-4 rounded-lg shadow-md hover:opacity-90 transition-opacity">Travel Roll</button>
                <button onClick={onResetAll} className="bg-transparent border border-border-color text-muted py-2 px-4 rounded-lg hover:bg-glass transition-colors">Reset All</button>
            </div>
            
            <hr className="border-border-color my-6" />

            <h4 className="text-lg font-bold mb-4">Long Rest (Nacht-Encounters)</h4>
            <div className="grid grid-cols-2 gap-4">
                 <div>
                    <label className="block text-sm text-muted mb-1">Anzahl Wachschichten</label>
                    <input type="number" min="1" max="8" value={settings.watchCount} onChange={handleWatchCountChange} className="w-full p-2 rounded-lg border border-border-color bg-input-bg text-white" />
                </div>
                <div>
                    <label className="block text-sm text-muted mb-1">Stunden mit Licht (0-8)</label>
                    <input type="number" min="0" max="8" value={settings.lightHours} onChange={e => handleSettingsChange('lightHours', parseInt(e.target.value, 10))} className="w-full p-2 rounded-lg border border-border-color bg-input-bg text-white" />
                </div>
            </div>

            <div className="mt-4 space-y-2">
                {settings.watches.map((watch, index) => (
                    <div key={index} className="grid grid-cols-1 md:grid-cols-[auto,1fr,1fr,120px] gap-3 items-end p-3 bg-glass rounded-lg">
                        <div className="font-bold text-accent self-center">Wache {index + 1}</div>
                        <div>
                            <label className="text-xs text-muted">Charakter</label>
                            <input value={watch.name} onChange={e => handleWatchChange(index, 'name', e.target.value)} placeholder="Name" className="w-full p-1.5 text-sm rounded-md border border-border-color bg-input-bg text-white" />
                        </div>
                        <div>
                            <label className="text-xs text-muted">Vision-Typ</label>
                            <select value={watch.vision} onChange={e => handleWatchChange(index, 'vision', e.target.value as Vision)} className="w-full p-1.5 text-sm rounded-md border border-border-color bg-input-bg text-white">
                                {Object.entries(VISION_NAMES).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="text-xs text-muted">Passive Perception</label>
                            <input type="number" min="1" max="30" value={watch.pp} onChange={e => handleWatchChange(index, 'pp', parseInt(e.target.value, 10))} className="w-full p-1.5 text-sm rounded-md border border-border-color bg-input-bg text-white" />
                        </div>
                    </div>
                ))}
            </div>
            
            <div className="flex gap-2 mt-4">
                <button onClick={onRestRoll} className="flex-1 bg-gradient-to-r from-accent to-sky-500 text-bg-secondary font-bold py-2 px-4 rounded-lg shadow-md hover:opacity-90 transition-opacity">Long Rest würfeln</button>
            </div>
        </div>
    );
};

// --- LogCard ---
interface LogCardProps {
    log: string[];
    result: string;
    onResetLog: () => void;
}

const LogCard: React.FC<LogCardProps> = ({ log, result, onResetLog }) => {
    return (
        <div className="bg-card rounded-xl p-4 shadow-lg flex flex-col">
            <div className="flex justify-between items-center mb-2">
                <h3 className="text-xl font-bold">Log & Ergebnisse</h3>
                <button onClick={onResetLog} className="bg-transparent border border-border-color text-muted text-sm py-1 px-3 rounded-lg hover:bg-glass transition-colors">Log leeren</button>
            </div>

            <div className="p-3 mb-2 rounded-lg bg-glass text-white" dangerouslySetInnerHTML={{ __html: result.replace(/(\b(hostile|neutral|poi|gewinnen|verlieren|erkannt|verpasst|verhindert|überrascht)\b)/gi, '<strong class="text-accent">$1</strong>') }} />
            
            <div className="flex-grow h-64 overflow-y-auto p-2 rounded-lg bg-gradient-to-b from-[rgba(255,255,255,0.01)] to-[rgba(255,255,255,0.02)] font-mono text-sm text-muted">
                {log.map((entry, index) => (
                    <p key={index} className="whitespace-pre-wrap">{entry}</p>
                ))}
            </div>
        </div>
    );
};

// --- MatrixEditor ---
interface MatrixEditorProps {
    matrix: Matrix;
    setMatrix: React.Dispatch<React.SetStateAction<Matrix>>;
    addLog: (msg: string) => void;
    triggerModal: (type: ModalType, title: string, message: React.ReactNode, onConfirm?: () => void) => void;
}

const MatrixInput: React.FC<{ value: number, onChange: (val: number) => void, onReset: () => void }> = ({ value, onChange, onReset }) => (
    <div className="flex items-center gap-1 justify-center">
        <input 
            type="number" 
            value={value} 
            onChange={e => onChange(parseInt(e.target.value, 10) || 0)}
            className="w-14 p-1 text-center rounded-md border border-border-color bg-input-bg text-white"
        />
        <button onClick={onReset} title="Reset to default" className="text-muted hover:text-accent transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M4 4l16 16" /></svg>
        </button>
    </div>
);

const MatrixEditor: React.FC<MatrixEditorProps> = ({ matrix, setMatrix, addLog, triggerModal }) => {
    const handleDayMatrixChange = (area: DayMatrixArea, type: keyof EncounterRange, index: 0 | 1, value: number) => {
        setMatrix(prev => {
            const newMatrix = JSON.parse(JSON.stringify(prev));
            newMatrix.day[area][type][index] = value;
            
            const ranges = (['hostile', 'neutral', 'poi'] as const)
                .map(t => ({ name: t, from: newMatrix.day[area][t][0], to: newMatrix.day[area][t][1] }))
                .sort((a, b) => a.from - b.from);
            
            let changed = false;
            for (let i = 0; i < ranges.length - 1; i++) {
                const current = ranges[i];
                const next = ranges[i + 1];
                if (current.to >= next.from && current.to > 0 && next.from > 0) {
                    const gap = current.to - next.from + 1;
                    newMatrix.day[next.name][0] += gap;
                    newMatrix.day[next.name][1] += gap;
                    changed = true;
                }
            }

            if (changed) addLog(`Matrix: Bereiche für '${area}' automatisch angepasst.`);
            return newMatrix;
        });
    };
    
    const handleNightMatrixChange = (area: NightMatrixArea, type: 'basis' | 'light', value: number, index?: 0 | 1) => {
         setMatrix(prev => {
            const newMatrix = JSON.parse(JSON.stringify(prev));
            const defaults = DEFAULTS.night[area];
            
            if (type === 'basis' && (index === 0 || index === 1)) {
                newMatrix.night[area][type][index] = value;
            } else if (type === 'light') {
                newMatrix.night[area][type] = value;
            }
            return newMatrix;
        });
    }

    const resetMatrix = () => {
        triggerModal(
            'confirm', 
            'Matrix Reset', 
            'Möchtest du wirklich die gesamte Encounter-Matrix auf die Standardwerte zurücksetzen?',
            () => {
                setMatrix(JSON.parse(JSON.stringify(DEFAULTS)));
                addLog('Gesamte Matrix auf Standardwerte zurückgesetzt.');
            }
        );
    };

    return (
        <section className="bg-card rounded-xl p-4 shadow-lg mt-4">
            <div className="flex flex-col sm:flex-row justify-between sm:items-center mb-4 gap-2">
                <h3 className="text-xl font-bold">Begegnungs-Matrix (editierbar)</h3>
                <button onClick={resetMatrix} className="bg-transparent border border-border-color text-muted py-1 px-3 rounded-lg hover:bg-glass transition-colors text-sm">🔄 Gesamte Matrix zurücksetzen</button>
            </div>
            <div className="text-sm p-3 bg-glass rounded-lg mb-4 text-muted">
                <strong>Anleitung:</strong> Tragen Sie die Würfelwerte ein (d100). Bei Änderungen werden andere Bereiche automatisch angepasst, um Überschneidungen zu vermeiden.
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <div>
                    <h4 className="font-bold mb-2">Tag-Encounters</h4>
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm text-center">
                            <thead className="text-muted">
                                <tr>
                                    <th className="p-2 border border-border-color text-left">Gebiet</th>
                                    <th className="p-2 border border-border-color" colSpan={2}>Hostile (d100)</th>
                                    <th className="p-2 border border-border-color" colSpan={2}>Neutral (d100)</th>
                                    <th className="p-2 border border-border-color" colSpan={2}>POI (d100)</th>
                                </tr>
                            </thead>
                            <tbody>
                                {Object.entries(matrix.day).map(([area, data]) => (
                                    <tr key={area}>
                                        <td className="p-2 border border-border-color text-left font-semibold">{area}</td>
                                        {(['hostile', 'neutral', 'poi'] as const).flatMap(type => [
                                            <td key={`${area}-${type}-0`} className="p-1 border border-border-color"><MatrixInput value={data[type][0]} onChange={v => handleDayMatrixChange(area as DayMatrixArea, type, 0, v)} onReset={() => handleDayMatrixChange(area as DayMatrixArea, type, 0, DEFAULTS.day[area as DayMatrixArea][type][0])} /></td>,
                                            <td key={`${area}-${type}-1`} className="p-1 border border-border-color"><MatrixInput value={data[type][1]} onChange={v => handleDayMatrixChange(area as DayMatrixArea, type, 1, v)} onReset={() => handleDayMatrixChange(area as DayMatrixArea, type, 1, DEFAULTS.day[area as DayMatrixArea][type][1])} /></td>
                                        ])}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
                <div>
                    <h4 className="font-bold mb-2">Nacht-Encounters</h4>
                    <div className="overflow-x-auto">
                         <table className="w-full border-collapse text-sm text-center">
                            <thead className="text-muted">
                                <tr>
                                    <th className="p-2 border border-border-color text-left">Gebiet</th>
                                    <th className="p-2 border border-border-color" colSpan={2}>Basis (d100)</th>
                                    <th className="p-2 border border-border-color">+Licht/Std</th>
                                </tr>
                            </thead>
                            <tbody>
                                {Object.entries(matrix.night).map(([area, val]) => {
                                    const data = val as NightEncounterParams;
                                    const areaKey = area as NightMatrixArea;
                                    const defaults = DEFAULTS.night[areaKey] as NightEncounterParams;
                                    return (
                                        <tr key={area}>
                                            <td className="p-2 border border-border-color text-left font-semibold">{area}</td>
                                            <td className="p-1 border border-border-color"><MatrixInput value={data.basis[0]} onChange={v => handleNightMatrixChange(areaKey, 'basis', v, 0)} onReset={() => handleNightMatrixChange(areaKey, 'basis', defaults.basis[0], 0)} /></td>
                                            <td className="p-1 border border-border-color"><MatrixInput value={data.basis[1]} onChange={v => handleNightMatrixChange(areaKey, 'basis', v, 1)} onReset={() => handleNightMatrixChange(areaKey, 'basis', defaults.basis[1], 1)} /></td>
                                            <td className="p-1 border border-border-color"><MatrixInput value={data.light} onChange={v => handleNightMatrixChange(areaKey, 'light', v)} onReset={() => handleNightMatrixChange(areaKey, 'light', defaults.light)} /></td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </section>
    );
};

// --- FlowPanels ---
interface FlowPanelsProps {
    flowState: FlowState;
    setFlowState: React.Dispatch<React.SetStateAction<FlowState | null>>;
    setResult: (result: string) => void;
    addLog: (msg: string) => void;
    triggerModal: (type: ModalType, title: string, message: React.ReactNode, onConfirm?: () => void) => void;
}

const FlowPanel: React.FC<{ title: string, children: React.ReactNode }> = ({ title, children }) => (
    <div className="bg-card rounded-xl p-4 shadow-lg">
        <h4 className="text-lg font-bold mb-4">{title}</h4>
        {children}
    </div>
);

const FlowPanels: React.FC<FlowPanelsProps> = ({ flowState, setFlowState, setResult, addLog, triggerModal }) => {
    // ... Existing FlowPanels implementation remains identical ...
    // To save tokens, I'm condensing this part as it wasn't requested to change, 
    // but in a full rewrite I'd include it. For this output, I'll assume the user
    // puts the previous FlowPanels code here.
    // *RESTORING PREVIOUS LOGIC FOR COMPLETENESS TO AVOID ERRORS*
    const [localInput, setLocalInput] = useState<{ [key: string]: string }>({});
    const handleInputChange = (key: string, value: string) => setLocalInput(prev => ({ ...prev, [key]: value }));
    const cancelFlow = () => { setResult('Ablauf abgebrochen.'); setFlowState(null); };

    const panelContent = useMemo(() => {
        switch (flowState.step) {
            case 'enemyStealthChoice': return (
                <FlowPanel title="Versuchen die Gegner sich anzuschleichen?">
                    <div className="flex gap-2">
                        <button className="flex-1 bg-accent text-bg-secondary font-bold py-2 px-4 rounded-lg" onClick={() => setFlowState({ ...flowState, step: 'enemyStealthInput' })}>Ja</button>
                        <button className="flex-1 bg-transparent border border-border-color text-muted py-2 px-4 rounded-lg" onClick={() => {
                            if (flowState.context === 'night') {
                                setResult('Normale Begegnung. Wache bemerkt Gegner automatisch.');
                                addLog('Nacht-Encounter ohne Gegner-Stealth → alle wach');
                                setFlowState(null);
                            } else {
                                setFlowState({ ...flowState, step: 'ppContest', enemyStealthAvg: null });
                            }
                        }}>Nein</button>
                    </div>
                </FlowPanel>
            );
            case 'enemyStealthInput': return (
                <FlowPanel title="Gegner Stealth Rolls">
                    <input autoFocus placeholder="z.B. 12, 13, 14" value={localInput.enemyRolls || ''} onChange={e => handleInputChange('enemyRolls', e.target.value)} className="w-full p-2 mb-2 rounded-lg border border-border-color bg-input-bg text-white" />
                    <div className="flex gap-2">
                        <button className="flex-1 bg-accent text-bg-secondary font-bold py-2 px-4 rounded-lg" onClick={() => {
                            const rolls = parseInts(localInput.enemyRolls || '');
                            if (!rolls.length) return triggerModal('alert', 'Fehler', 'Bitte Würfe eingeben.');
                            const enemyStealthAvg = Math.round(avg(rolls));
                            addLog(`Gegner Stealth: [${rolls.join(', ')}] → ø ${enemyStealthAvg}`);
                            setFlowState({ ...flowState, step: 'detection', enemyStealthAvg });
                        }}>Bestätigen</button>
                        <button className="flex-1 bg-transparent border border-border-color text-muted py-2 px-4 rounded-lg" onClick={cancelFlow}>Abbrechen</button>
                    </div>
                </FlowPanel>
            );
            case 'ppContest': return (
                <FlowPanel title="Passive Perception Contest">
                    <div className="grid grid-cols-2 gap-4 mb-4">
                        <div>
                            <label className="text-sm text-muted">Höchste PP der Gruppe</label>
                            <input autoFocus type="number" min="1" value={localInput.playerPP || ''} onChange={e => handleInputChange('playerPP', e.target.value)} className="w-full p-2 rounded-lg border border-border-color bg-input-bg text-white" />
                        </div>
                         <div>
                            <label className="text-sm text-muted">Höchste PP der Gegner</label>
                            <input type="number" min="1" value={localInput.enemyPP || ''} onChange={e => handleInputChange('enemyPP', e.target.value)} className="w-full p-2 rounded-lg border border-border-color bg-input-bg text-white" />
                        </div>
                    </div>
                    <div className="flex gap-2">
                         <button className="flex-1 bg-accent text-bg-secondary font-bold py-2 px-4 rounded-lg" onClick={() => {
                            const playerPP = parseInt(localInput.playerPP || '0');
                            const enemyPP = parseInt(localInput.enemyPP || '0');
                            if (!playerPP || !enemyPP) return triggerModal('alert', 'Fehler', 'Bitte gültige PP-Werte eingeben.');
                            addLog(`PP Contest: Spieler ${playerPP} vs Gegner ${enemyPP}`);
                            if (playerPP > enemyPP) {
                                setResult(`Spieler gewinnen (${playerPP} > ${enemyPP}) → Gruppe kann schleichen`);
                                setFlowState({...flowState, step: 'stealthChoice', winner: 'players', playerPP, enemyPP});
                            } else if (enemyPP > playerPP) {
                                setResult(`Gegner gewinnen (${enemyPP} > ${playerPP}) → Gegner können schleichen`);
                                setFlowState({...flowState, step: 'stealthChoice', winner: 'enemies', playerPP, enemyPP});
                            } else {
                                setResult(`Unentschieden (${playerPP} = ${enemyPP}) → Normale Begegnung`);
                                addLog('PP Contest unentschieden → normale Begegnung');
                                setFlowState(null);
                            }
                         }}>Auswerten</button>
                        <button className="flex-1 bg-transparent border border-border-color text-muted py-2 px-4 rounded-lg" onClick={cancelFlow}>Abbrechen</button>
                    </div>
                </FlowPanel>
            );
             case 'stealthChoice': return (
                <FlowPanel title={flowState.winner === 'players' ? 'Möchte die Gruppe schleichen?' : 'Versuchen die Gegner zu schleichen?'}>
                    <p className="text-muted mb-4">{flowState.winner === 'players' ? 'Die Gruppe hat die Gegner zuerst bemerkt.' : 'Die Gegner haben die Gruppe zuerst bemerkt.'}</p>
                    {flowState.winner === 'players' && flowState.vehicle && <div className="p-2 mb-2 bg-bad/20 border border-bad/50 text-bad rounded-lg text-sm">⚠️ FAHRZEUG AKTIV: Alle Stealth-Checks mit Nachteil würfeln!</div>}
                     <div className="flex gap-2 mb-4">
                        <button className="flex-1 bg-accent text-bg-secondary font-bold py-2 px-4 rounded-lg" onClick={() => setFlowState({ ...flowState, step: 'stealthInput' })}>Ja, schleichen</button>
                        <button className="flex-1 bg-transparent border border-border-color text-muted py-2 px-4 rounded-lg" onClick={() => {
                            setResult('Normale Begegnung (kein Stealth).');
                            setFlowState(null);
                        }}>Nein, normale Begegnung</button>
                    </div>
                </FlowPanel>
            );
            case 'stealthInput': return (
                <FlowPanel title="Stealth Rolls eingeben">
                     <input autoFocus placeholder="z.B. 14, 13, 10, 18" value={localInput.stealthRolls || ''} onChange={e => handleInputChange('stealthRolls', e.target.value)} className="w-full p-2 mb-2 rounded-lg border border-border-color bg-input-bg text-white" />
                    <div className="flex gap-2">
                        <button className="flex-1 bg-accent text-bg-secondary font-bold py-2 px-4 rounded-lg" onClick={() => {
                             const rolls = parseInts(localInput.stealthRolls || '');
                            if (!rolls.length) return triggerModal('alert', 'Fehler', 'Bitte Würfe eingeben.');
                            const stealthAvg = Math.round(avg(rolls));
                            addLog(`Stealth: [${rolls.join(', ')}] → ø ${stealthAvg}`);
                            setFlowState({ ...flowState, step: 'detection', stealthAvg });
                        }}>Auswerten</button>
                        <button className="flex-1 bg-transparent border border-border-color text-muted py-2 px-4 rounded-lg" onClick={cancelFlow}>Abbrechen</button>
                    </div>
                </FlowPanel>
            );
            case 'detection':
                const isNight = flowState.context === 'night';
                const threshold = flowState.enemyStealthAvg ?? flowState.stealthAvg ?? 0;
                let label = "Passive Perception Wert";
                let defaultValue = "10";
                if(isNight && flowState.watchPerception) {
                    label = `Aktive Perception der Wache (${flowState.affectedWatch?.name})`;
                    defaultValue = flowState.watchPerception.effectivePP.toString();
                } else if(flowState.winner === 'players') {
                    label = "Höchste PP der Gegner";
                    defaultValue = flowState.enemyPP?.toString() ?? "10";
                } else if (flowState.winner === 'enemies') {
                    label = "Höchste PP der Gruppe";
                    defaultValue = flowState.playerPP?.toString() ?? "10";
                }

                return (
                    <FlowPanel title="Detection Check">
                        <label className="text-sm text-muted">{label}</label>
                        <input autoFocus type="number" min="1" value={localInput.detectionPP ?? defaultValue} onChange={e => handleInputChange('detectionPP', e.target.value)} className="w-full p-2 mb-2 rounded-lg border border-border-color bg-input-bg text-white" />
                        <div className="flex gap-2">
                            <button className="flex-1 bg-accent text-bg-secondary font-bold py-2 px-4 rounded-lg" onClick={() => {
                                const detectionPP = parseInt(localInput.detectionPP ?? defaultValue);
                                addLog(`Detection: PP ${detectionPP} vs Stealth ${threshold}`);
                                if (detectionPP >= threshold) {
                                    setResult(isNight ? `Gegner erkannt! Wache weckt alle.` : `Stealth erkannt! Normale Begegnung.`);
                                    addLog(isNight ? `Gegner durch ${flowState.affectedWatch?.name} erkannt → alle wach` : 'Stealth erkannt → normale Begegnung');
                                } else {
                                    if(isNight) {
                                         setResult(`Gruppe überrascht! Nur ${flowState.affectedWatch?.name} ist wach.`);
                                         addLog(`Gruppe überrascht → nur ${flowState.affectedWatch?.name} wach`);
                                    } else if(flowState.winner === 'players'){
                                        setResult(`Begegnung vermieden! Erfolgreich geschlichen.`);
                                        addLog('Begegnung vermieden → Gruppe erfolgreich geschlichen');
                                    } else {
                                        setResult(`Gruppe überrascht! Gegner erfolgreich geschlichen.`);
                                        addLog('Gruppe überrascht → Gegner erfolgreich geschlichen');
                                    }
                                }
                                setFlowState(null);
                            }}>Auswerten</button>
                            <button className="flex-1 bg-transparent border border-border-color text-muted py-2 px-4 rounded-lg" onClick={cancelFlow}>Abbrechen</button>
                        </div>
                    </FlowPanel>
                );
            case 'nightEncounterInfo': return (
                <FlowPanel title={`Nacht-Encounter: ${flowState.affectedWatch?.name}`}>
                     <div className="text-muted mb-4 space-y-1">
                        <p><strong>Vision:</strong> {flowState.affectedWatch?.vision ? VISION_NAMES[flowState.affectedWatch.vision] : 'N/A'}</p>
                        <p><strong>Effektive PP:</strong> {flowState.watchPerception?.effectivePP} ({flowState.watchPerception?.modifier})</p>
                     </div>
                     {flowState.affectedWatch?.vision === 'darkvision' && <div className="p-2 mb-2 bg-bad/20 border border-bad/50 text-bad rounded-lg text-sm">⚠️ DARKVISION AKTIV: Aktive Perception-Checks mit Nachteil würfeln!</div>}
                     <div className="flex gap-2">
                        <button className="flex-1 bg-accent text-bg-secondary font-bold py-2 px-4 rounded-lg" onClick={() => setFlowState({ ...flowState, step: 'enemyStealthChoice' })}>Stealth-Mechanik starten</button>
                        <button className="flex-1 bg-transparent border border-border-color text-muted py-2 px-4 rounded-lg" onClick={cancelFlow}>Abbrechen</button>
                    </div>
                </FlowPanel>
            );
            default: return null;
        }
    }, [flowState, localInput, setFlowState, setResult, addLog, triggerModal]);

    if (!panelContent) return null;
    return <div className="mt-4">{panelContent}</div>;
};

// --- ResourceManager (New) ---
interface ResourceManagerProps {
    creatures: Creature[];
    setCreatures: React.Dispatch<React.SetStateAction<Creature[]>>;
    storages: Storage[];
    setStorages: React.Dispatch<React.SetStateAction<Storage[]>>;
    addLog: (msg: string) => void;
    triggerModal: (type: ModalType, title: string, message: React.ReactNode, onConfirm?: () => void) => void;
    settings: Settings;
}

interface ForageState {
    step: 'idle' | 'config' | 'input' | 'result';
    dc: number;
    wisMod: number;
    checkResult: number;
    foodFound: number;
    waterFound: number;
    mishap: boolean;
    // Separate storage selections for food and water
    selectedFoodStoreId: string;
    selectedWaterStoreId: string;
    isRanger: boolean;
}

interface RationingState {
    isOpen: boolean;
    selections: Record<string, { food: boolean, water: boolean }>;
}

const ResourceManager: React.FC<ResourceManagerProps> = ({ creatures, setCreatures, storages, setStorages, addLog, triggerModal, settings }) => {
    // State to handle Undo functionality
    const [lastStoragesState, setLastStoragesState] = useState<Storage[] | null>(null);
    const [lastCreaturesState, setLastCreaturesState] = useState<Creature[] | null>(null); // Undo for stats too
    const [consumptionMsg, setConsumptionMsg] = useState<string | null>(null);
    
    // Weather State
    const [isHotWeather, setIsHotWeather] = useState(false);

    // Rationing Modal State
    const [rationing, setRationing] = useState<RationingState>({ isOpen: false, selections: {} });

    // Foraging State
    const [forageState, setForageState] = useState<ForageState>({
        step: 'idle',
        dc: 15,
        wisMod: 0,
        checkResult: 0,
        foodFound: 0,
        waterFound: 0,
        mishap: false,
        selectedFoodStoreId: '',
        selectedWaterStoreId: '',
        isRanger: false
    });

    // Helper to filter available storages
    const getAvailableStorages = (type: StorageType) => {
        return storages.filter(s => {
            if (!s.isActive) return false;
            if (s.storageType !== type) return false;
            // Check capacity
            const current = type === 'water' ? s.water : (s.food + (s.feed||0));
            return current < s.maxCapacity;
        });
    };

    // Auto-select first available storage when result opens
    useEffect(() => {
        if (forageState.step === 'result') {
            const availFood = getAvailableStorages('food_feed');
            const availWater = getAvailableStorages('water');
            
            setForageState(prev => ({
                ...prev,
                selectedFoodStoreId: availFood.length > 0 ? availFood[0].id : '',
                selectedWaterStoreId: availWater.length > 0 ? availWater[0].id : ''
            }));
        }
    }, [forageState.step, storages]); // Re-run when storages change (e.g. fill up)

    // Helper for controlled number inputs
    const handleNumberChange = (
        id: string, 
        field: keyof Storage | keyof Creature, 
        valueStr: string, 
        setter: Function, 
        list: any[]
    ) => {
        setter((prev: any[]) => prev.map(item => {
            if (item.id !== id) return item;
            const num = valueStr === '' ? 0 : parseFloat(valueStr);
            return { ...item, [field]: isNaN(num) ? 0 : num };
        }));
    };
    
    // Helper to handle switching storage type and clearing incompatible data
    const handleStorageTypeChange = (id: string, newType: StorageType) => {
        setStorages(prev => prev.map(s => {
            if (s.id !== id) return s;
            // When switching type, clear the incompatible resource
            return {
                ...s,
                storageType: newType,
                food: newType === 'water' ? 0 : s.food,
                feed: newType === 'water' ? 0 : s.feed,
                water: newType === 'food_feed' ? 0 : s.water
            };
        }));
    };

    const addCreature = () => setCreatures(prev => [...prev, { id: generateId(), name: 'Neuer Charakter', size: 'Medium', usesFeed: false, conMod: 0, daysWithoutFood: 0, exhaustion: 0 }]);
    const updateCreature = (id: string, field: keyof Creature, value: any) => setCreatures(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
    const removeCreature = (id: string) => { 
        triggerModal('confirm', 'Löschen', 'Eintrag wirklich löschen?', () => {
            setCreatures(prev => prev.filter(c => c.id !== id));
        });
    };

    const addStorage = () => setStorages(prev => [...prev, { id: generateId(), name: 'Neues Lager', isActive: true, storageType: 'food_feed', maxCapacity: 100, food: 0, water: 0, feed: 0 }]);
    const updateStorage = (id: string, field: keyof Storage, value: any) => setStorages(prev => prev.map(s => s.id === id ? { ...s, [field]: value } : s));
    const removeStorage = (id: string) => { 
        triggerModal('confirm', 'Lager löschen', 'Dieses Lager wirklich löschen?', () => {
            setStorages(prev => prev.filter(s => s.id !== id));
        });
    };

    // Calculate requirements per creature based on size and weather
    const getRequirements = (c: Creature) => {
        const rate = CONSUMPTION_RATES[c.size] || CONSUMPTION_RATES['Medium'];
        // Default to count 1 since we removed the count field
        const count = 1;
        // Water is doubled in hot weather
        const waterRate = isHotWeather ? rate.water * 2 : rate.water;
        
        return {
            food: c.usesFeed ? 0 : (rate.food * count),
            feed: c.usesFeed ? (rate.feed * count) : 0,
            water: waterRate * count
        };
    };

    const totalNeeds = useMemo(() => {
        return creatures.reduce((acc, c) => {
            const req = getRequirements(c);
            return {
                food: acc.food + req.food,
                water: acc.water + req.water,
                feed: acc.feed + req.feed
            };
        }, { food: 0, water: 0, feed: 0 });
    }, [creatures, isHotWeather]);

    const totalStored = useMemo(() => {
        return storages.reduce((acc, s) => {
            // IGNORE INACTIVE STORAGES IN CALCULATION
            if (!s.isActive) return acc;
            
            return {
                food: acc.food + safeFloat(s.food),
                water: acc.water + safeFloat(s.water),
                feed: acc.feed + safeFloat(s.feed || 0)
            };
        }, { food: 0, water: 0, feed: 0 });
    }, [storages]);

    // --- CONSUMPTION LOGIC ---

    const openRationingModal = () => {
        // Init selections: Default to TRUE (everyone eats/drinks)
        const initialSelections: Record<string, { food: boolean, water: boolean }> = {};
        creatures.forEach(c => {
            initialSelections[c.id] = { food: true, water: true };
        });
        setRationing({ isOpen: true, selections: initialSelections });
    };

    // Calculate current selection totals within the modal
    const rationingTotals = useMemo(() => {
        if (!rationing.isOpen) return { food: 0, feed: 0, water: 0 };
        return creatures.reduce((acc, c) => {
            const sel = rationing.selections[c.id];
            if (!sel) return acc;
            
            const req = getRequirements(c);
            return {
                food: acc.food + (sel.food ? req.food : 0),
                feed: acc.feed + (sel.food ? req.feed : 0), // "food" checkbox controls feed for animals
                water: acc.water + (sel.water ? req.water : 0)
            };
        }, { food: 0, feed: 0, water: 0 });
    }, [rationing, creatures, isHotWeather]);

    const toggleSelection = (creatureId: string, type: 'food' | 'water') => {
        setRationing(prev => ({
            ...prev,
            selections: {
                ...prev.selections,
                [creatureId]: {
                    ...prev.selections[creatureId],
                    [type]: !prev.selections[creatureId][type]
                }
            }
        }));
    };

    const confirmConsumption = () => {
        const needs = rationingTotals;
        // Check if we have enough
        const epsilon = 0.001;
        if (needs.food > totalStored.food + epsilon || 
            needs.feed > totalStored.feed + epsilon || 
            needs.water > totalStored.water + epsilon) {
            // Should be disabled in UI, but safety check
            return;
        }

        // 1. Save State for Undo
        setLastStoragesState(JSON.parse(JSON.stringify(storages)));
        setLastCreaturesState(JSON.parse(JSON.stringify(creatures)));

        // 2. Consume Resources
        const newStorages = storages.map(s => ({...s}));
        let foodNeeded = needs.food;
        let feedNeeded = needs.feed;
        let waterNeeded = needs.water;

        for (const store of newStorages) {
            // SKIP INACTIVE STORAGES DURING CONSUMPTION
            if (!store.isActive) continue;

            let sFood = safeFloat(store.food);
            let sFeed = safeFloat(store.feed || 0);
            let sWater = safeFloat(store.water);

            if (foodNeeded > epsilon && sFood > epsilon) { const t = Math.min(sFood, foodNeeded); sFood -= t; foodNeeded -= t; }
            if (feedNeeded > epsilon && sFeed > epsilon) { const t = Math.min(sFeed, feedNeeded); sFeed -= t; feedNeeded -= t; }
            if (waterNeeded > epsilon && sWater > epsilon) { const t = Math.min(sWater, waterNeeded); sWater -= t; waterNeeded -= t; }

            store.food = Math.round(sFood * 100) / 100;
            store.feed = Math.round(sFeed * 100) / 100;
            store.water = Math.round(sWater * 100) / 100;
        }
        setStorages(newStorages);

        // 3. Apply Consequences to Creatures
        const newCreatures = creatures.map(c => {
            const sel = rationing.selections[c.id];
            if (!sel) return c; // Should not happen
            
            let newDaysWithoutFood = c.daysWithoutFood;
            let newExhaustion = c.exhaustion;

            // Food Logic
            if (sel.food) {
                newDaysWithoutFood = 0; // Reset on full meal
            } else {
                newDaysWithoutFood += 1;
                // Rule: > 3 + ConMod days = 1 Exhaustion
                const limit = Math.max(1, 3 + (c.conMod || 0));
                if (newDaysWithoutFood > limit) {
                    newExhaustion += 1;
                }
            }

            // Water Logic
            if (!sel.water) {
                // Rule: Less than half water = 1 exhaustion (or 2 if already exhausted)
                // We treat unchecked as "no/little water"
                if (newExhaustion > 0) {
                    newExhaustion += 2;
                } else {
                    newExhaustion += 1;
                }
            }

            // Recovery Logic
            // Base:
            newExhaustion = c.exhaustion;
            
            // Penalties first
            let gainedExhaustion = 0;
            
            // Hunger Penalty
            if (!sel.food) {
                newDaysWithoutFood = c.daysWithoutFood + 1;
                 const limit = Math.max(1, 3 + (c.conMod || 0));
                if (newDaysWithoutFood > limit) gainedExhaustion++;
            } else {
                newDaysWithoutFood = 0;
            }

            // Thirst Penalty
            if (!sel.water) {
                gainedExhaustion += (c.exhaustion + gainedExhaustion > 0) ? 2 : 1;
            }

            // Apply Gains
            newExhaustion += gainedExhaustion;

            // Recovery: If needs met (no gains calculated) AND had previous exhaustion -> recover 1
            if (sel.food && sel.water && gainedExhaustion === 0 && c.exhaustion > 0) {
                newExhaustion -= 1;
            }
            
            // Cap Exhaustion at 6 (Death) - though we just show 6
            newExhaustion = Math.min(6, Math.max(0, newExhaustion));

            return {
                ...c,
                daysWithoutFood: newDaysWithoutFood,
                exhaustion: newExhaustion
            };
        });

        setCreatures(newCreatures);
        setRationing({ isOpen: false, selections: {} });
        
        const fedCount = Object.values(rationing.selections).filter(s => s.food).length;
        setConsumptionMsg(`Tagesabschluss: ${fedCount}/${creatures.length} versorgt.`);
        addLog(`Tagesabschluss durchgeführt. Ressourcen verbraucht. Konsequenzen (Hunger/Durst) angewendet.`);
        
        setTimeout(() => setConsumptionMsg(null), 5000);
    };

    const handleUndo = () => {
        if (!lastStoragesState || !lastCreaturesState) return;
        setStorages(lastStoragesState);
        setCreatures(lastCreaturesState);
        setLastStoragesState(null);
        setLastCreaturesState(null);
        setConsumptionMsg("Rückgängig gemacht.");
        addLog("Tagesabschluss widerrufen.");
        setTimeout(() => setConsumptionMsg(null), 3000);
    };

    // --- Foraging Logic ---
    const startForaging = () => {
        if (settings.pace === 'fast') {
            triggerModal('alert', 'Nicht möglich', 'Bei schnellem Reisetempo kann nicht gesammelt werden (Pace: Fast).');
            return;
        }
        setForageState({ ...forageState, step: 'config', dc: 15, wisMod: 0, checkResult: 0, isRanger: false });
    };

    const handleWandererFeature = () => {
        setForageState(prev => ({ 
            ...prev, 
            step: 'result', 
            foodFound: 6, 
            waterFound: 6, 
            mishap: false, 
            checkResult: 999 
        }));
        addLog(`Nahrungssuche: "Wanderer" (Outlander) Feature genutzt. Automatisch 6lb Essen, 6gal Wasser gefunden.`);
    };

    const handleCreateFoodSpell = () => {
        setForageState(prev => ({ 
            ...prev, 
            step: 'result', 
            foodFound: 45, 
            waterFound: 30, 
            mishap: false, 
            checkResult: 999 
        }));
        addLog(`Zauber "Create Food and Water" gewirkt. 45lb Essen, 30gal Wasser erschaffen.`);
    };

    const calculateForage = () => {
        const check = forageState.checkResult;
        const dc = forageState.dc;
        let food = 0;
        let water = 0;
        let mishap = false;

        const multiplier = forageState.isRanger ? 2 : 1;

        if (check >= dc) {
            const baseFood = Math.max(0, rnd(6) + forageState.wisMod);
            const baseWater = Math.max(0, rnd(6) + forageState.wisMod);
            food = baseFood * multiplier;
            water = baseWater * multiplier;
        } else if (check <= dc - 5) {
            mishap = true;
        }

        setForageState(prev => ({ 
            ...prev, 
            step: 'result', 
            foodFound: food, 
            waterFound: water, 
            mishap 
        }));
        
        let logMsg = `Nahrungssuche: DC ${dc}, Check ${check}.`;
        if (mishap) logMsg += ' MISSGESCHICK!';
        else if (check >= dc) {
            logMsg += ` Erfolg: ${food}lb Essen, ${water}gal Wasser`;
            if (forageState.isRanger) logMsg += ` (x2 durch Ranger)`;
        } else {
            logMsg += ' Fehlschlag.';
        }
        addLog(logMsg);
    };

    // Store Food Only
    const storeFood = () => {
        const targetId = forageState.selectedFoodStoreId;
        if(!targetId) return;
        const targetStorage = storages.find(s => s.id === targetId);
        if(!targetStorage) return;

        const currentLoad = targetStorage.food + (targetStorage.feed || 0);
        const space = targetStorage.maxCapacity - currentLoad;
        const toAdd = Math.min(space, forageState.foodFound);

        if(toAdd <= 0) {
            triggerModal('alert', 'Voll', 'Dieses Lager ist voll.');
            return;
        }

        setStorages(prev => prev.map(s => s.id === targetId ? { ...s, food: s.food + toAdd } : s));
        addLog(`Eingelagert in ${targetStorage.name}: ${toAdd}lb Essen.`);

        setForageState(prev => ({
            ...prev,
            foodFound: prev.foodFound - toAdd,
            // Re-eval selected ID done by effect, but safer to clear if full:
            selectedFoodStoreId: (space - toAdd <= 0) ? '' : targetId 
        }));
    };

    // Store Water Only
    const storeWater = () => {
        const targetId = forageState.selectedWaterStoreId;
        if(!targetId) return;
        const targetStorage = storages.find(s => s.id === targetId);
        if(!targetStorage) return;

        const space = targetStorage.maxCapacity - targetStorage.water;
        const toAdd = Math.min(space, forageState.waterFound);

        if(toAdd <= 0) {
            triggerModal('alert', 'Voll', 'Dieses Lager ist voll.');
            return;
        }

        setStorages(prev => prev.map(s => s.id === targetId ? { ...s, water: s.water + toAdd } : s));
        addLog(`Eingelagert in ${targetStorage.name}: ${toAdd}gal Wasser.`);

        setForageState(prev => ({
            ...prev,
            waterFound: prev.waterFound - toAdd,
             // Re-eval selected ID done by effect
             selectedWaterStoreId: (space - toAdd <= 0) ? '' : targetId 
        }));
    };
    
    const discardRemainingForage = () => {
        triggerModal('confirm', 'Rest wegwerfen?', `Möchtest du ${forageState.foodFound}lb Essen und ${forageState.waterFound}gal Wasser zurücklassen?`, () => {
             addLog(`Restliche Ressourcen weggeworfen: ${forageState.foodFound}lb Essen, ${forageState.waterFound}gal Wasser.`);
             setForageState(prev => ({...prev, step: 'idle'}));
        });
    }

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            
            {/* Rationing Modal */}
            {rationing.isOpen && (
                 <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                    <div className="bg-card border border-border-color rounded-xl shadow-2xl max-w-2xl w-full p-6 flex flex-col max-h-[90vh]">
                        <h3 className="text-xl font-bold mb-4 text-white">Rationierung & Verbrauch</h3>
                        
                        {/* Summary Header */}
                        <div className="grid grid-cols-3 gap-4 mb-4 text-center bg-glass p-3 rounded-lg">
                            <div>
                                <div className="text-xs text-muted">Essen (lb)</div>
                                <div className={`${rationingTotals.food > totalStored.food ? 'text-bad' : 'text-white'} font-bold`}>
                                    {rationingTotals.food.toFixed(1)} / {totalStored.food.toFixed(1)}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-muted">Tierfutter (Unit)</div>
                                <div className={`${rationingTotals.feed > totalStored.feed ? 'text-bad' : 'text-white'} font-bold`}>
                                    {rationingTotals.feed.toFixed(1)} / {totalStored.feed.toFixed(1)}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-muted">Wasser (gal)</div>
                                <div className={`${rationingTotals.water > totalStored.water ? 'text-bad' : 'text-white'} font-bold`}>
                                    {rationingTotals.water.toFixed(1)} / {totalStored.water.toFixed(1)}
                                </div>
                            </div>
                        </div>

                        <div className="overflow-y-auto flex-grow mb-4 border border-border-color rounded-lg">
                            <table className="w-full text-sm text-left">
                                <thead className="bg-white/5 text-muted sticky top-0">
                                    <tr>
                                        <th className="p-3">Name</th>
                                        <th className="p-3 text-center">Hunger / Exhaustion</th>
                                        <th className="p-3 text-center">Essen</th>
                                        <th className="p-3 text-center">Wasser</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border-color">
                                    {creatures.map(c => {
                                        const req = getRequirements(c);
                                        const sel = rationing.selections[c.id];
                                        if(!sel) return null;
                                        
                                        const willStarve = !sel.food && (c.daysWithoutFood + 1 > 3 + (c.conMod || 0));
                                        const willDehydrate = !sel.water;
                                        
                                        return (
                                            <tr key={c.id} className="hover:bg-white/5">
                                                <td className="p-3 font-medium">{c.name}</td>
                                                <td className="p-3 text-center">
                                                    <div className="flex justify-center gap-2">
                                                        {c.daysWithoutFood > 0 && <span className="text-orange-400 text-xs px-1.5 py-0.5 bg-orange-400/10 rounded">Hunger {c.daysWithoutFood}d</span>}
                                                        {c.exhaustion > 0 && <span className="text-bad text-xs px-1.5 py-0.5 bg-bad/10 rounded">💀 Lv {c.exhaustion}</span>}
                                                        {c.daysWithoutFood === 0 && c.exhaustion === 0 && <span className="text-muted text-xs">-</span>}
                                                    </div>
                                                    {(willStarve || willDehydrate) && (
                                                        <div className="text-[10px] text-bad mt-1">
                                                            {willStarve ? '+Exh (Hunger) ' : ''}
                                                            {willDehydrate ? '+Exh (Durst)' : ''}
                                                        </div>
                                                    )}
                                                </td>
                                                <td className="p-3 text-center">
                                                    <label className="flex flex-col items-center cursor-pointer group">
                                                        <input type="checkbox" checked={sel.food} onChange={() => toggleSelection(c.id, 'food')} className="w-5 h-5 rounded border-border-color bg-input-bg checked:bg-good mb-1" />
                                                        <span className="text-xs text-muted group-hover:text-white">
                                                            {c.usesFeed ? `${req.feed} Unit` : `${req.food} lb`}
                                                        </span>
                                                    </label>
                                                </td>
                                                <td className="p-3 text-center">
                                                     <label className="flex flex-col items-center cursor-pointer group">
                                                        <input type="checkbox" checked={sel.water} onChange={() => toggleSelection(c.id, 'water')} className="w-5 h-5 rounded border-border-color bg-input-bg checked:bg-accent mb-1" />
                                                        <span className="text-xs text-muted group-hover:text-white">
                                                            {req.water} gal
                                                        </span>
                                                    </label>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        <div className="flex gap-2">
                            <button 
                                onClick={confirmConsumption} 
                                disabled={rationingTotals.food > totalStored.food + 0.001 || rationingTotals.feed > totalStored.feed + 0.001 || rationingTotals.water > totalStored.water + 0.001}
                                className="flex-1 bg-gradient-to-r from-orange-500 to-red-500 text-white font-bold py-3 rounded-lg shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Bestätigen & Konsequenzen anwenden
                            </button>
                             <button 
                                onClick={() => setRationing({isOpen: false, selections: {}})} 
                                className="px-4 py-3 border border-border-color rounded-lg text-muted hover:bg-glass"
                            >
                                Abbrechen
                            </button>
                        </div>
                    </div>
                 </div>
            )}

            {/* Foraging Modal Overlay */}
            {forageState.step !== 'idle' && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                    <div className="bg-card border border-border-color rounded-xl shadow-2xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
                        {forageState.step === 'config' && (
                            <>
                                <h3 className="text-xl font-bold mb-4 text-white">Nahrungssuche: Einstellungen</h3>
                                <div className="space-y-4 mb-6">
                                    <div>
                                        <label className="text-sm text-muted block mb-2">Verfügbarkeit (DC)</label>
                                        <div className="grid grid-cols-3 gap-2">
                                            <button onClick={() => setForageState(prev => ({...prev, dc: 10}))} className={`p-2 rounded border border-border-color text-sm ${forageState.dc === 10 ? 'bg-accent text-bg-secondary font-bold' : 'bg-input-bg text-muted'}`}>Reichlich<br/>(DC 10)</button>
                                            <button onClick={() => setForageState(prev => ({...prev, dc: 15}))} className={`p-2 rounded border border-border-color text-sm ${forageState.dc === 15 ? 'bg-accent text-bg-secondary font-bold' : 'bg-input-bg text-muted'}`}>Begrenzt<br/>(DC 15)</button>
                                            <button onClick={() => setForageState(prev => ({...prev, dc: 20}))} className={`p-2 rounded border border-border-color text-sm ${forageState.dc === 20 ? 'bg-accent text-bg-secondary font-bold' : 'bg-input-bg text-muted'}`}>Karg<br/>(DC 20)</button>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="text-sm text-muted block mb-1">Wisdom (Survival) Modifier</label>
                                        <input type="number" value={forageState.wisMod} onChange={e => setForageState(prev => ({...prev, wisMod: parseInt(e.target.value)||0}))} className="w-full bg-input-bg rounded p-2 text-white border border-border-color" />
                                    </div>
                                    
                                    <div className="border-t border-border-color pt-4 mt-2">
                                        <label className="text-sm text-white font-bold block mb-2">Features & Modifikatoren</label>
                                        <div className="flex items-center gap-2 mb-3">
                                            <input 
                                                type="checkbox" 
                                                id="rangerCheck"
                                                checked={forageState.isRanger}
                                                onChange={e => setForageState(prev => ({...prev, isRanger: e.target.checked}))}
                                                className="w-4 h-4 rounded border-border-color bg-input-bg"
                                            />
                                            <label htmlFor="rangerCheck" className="text-sm text-muted cursor-pointer select-none">
                                                Natural Explorer (x2 Ertrag)
                                            </label>
                                        </div>

                                        <div className="grid grid-cols-1 gap-2">
                                            <button 
                                                onClick={handleWandererFeature}
                                                className="text-left px-3 py-2 bg-glass border border-border-color rounded hover:bg-white/5 transition-colors text-sm text-accent"
                                            >
                                                <strong>🌍 Wanderer (Outlander)</strong>
                                                <div className="text-xs text-muted mt-0.5">Automatischer Erfolg für 6 Personen (6lb/6gal).</div>
                                            </button>
                                            <button 
                                                onClick={handleCreateFoodSpell}
                                                className="text-left px-3 py-2 bg-glass border border-border-color rounded hover:bg-white/5 transition-colors text-sm text-purple-400"
                                            >
                                                <strong>✨ Zauber: Create Food & Water</strong>
                                                <div className="text-xs text-muted mt-0.5">Erschafft 45lb Essen & 30gal Wasser.</div>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <button onClick={() => setForageState(prev => ({...prev, step: 'input'}))} className="flex-1 bg-accent text-bg-secondary font-bold py-2 rounded-lg">Würfeln</button>
                                    <button onClick={() => setForageState(prev => ({...prev, step: 'idle'}))} className="flex-1 border border-border-color text-muted py-2 rounded-lg">Abbrechen</button>
                                </div>
                            </>
                        )}
                        {forageState.step === 'input' && (
                            <>
                                <h3 className="text-xl font-bold mb-4 text-white">Survival Check</h3>
                                <div className="mb-6">
                                    <label className="text-sm text-muted block mb-1">Wurfergebnis (d20 + Mod)</label>
                                    <input autoFocus type="number" min="1" onChange={e => setForageState(prev => ({...prev, checkResult: parseInt(e.target.value)||0}))} className="w-full bg-input-bg rounded p-3 text-xl text-center text-white border border-border-color" placeholder="0" />
                                    <p className="text-xs text-muted mt-2 text-center">Zielwert (DC): {forageState.dc}</p>
                                    {forageState.isRanger && <p className="text-xs text-accent mt-1 text-center font-bold">Ranger aktiv: Ertrag wird verdoppelt!</p>}
                                </div>
                                <div className="flex gap-2">
                                    <button onClick={calculateForage} className="flex-1 bg-accent text-bg-secondary font-bold py-2 rounded-lg">Check auswerten</button>
                                    <button onClick={() => setForageState(prev => ({...prev, step: 'config'}))} className="flex-1 border border-border-color text-muted py-2 rounded-lg">Zurück</button>
                                </div>
                            </>
                        )}
                         {forageState.step === 'result' && (
                            <>
                                <h3 className="text-xl font-bold mb-4 text-white">Ergebnis</h3>
                                <div className="mb-6 bg-glass p-4 rounded-lg text-center">
                                    {forageState.mishap ? (
                                        <div className="text-bad font-bold animate-pulse">
                                            <div className="text-3xl mb-2">⚠️</div>
                                            MISSGESCHICK!<br/>
                                            <span className="text-sm font-normal text-muted">Check ({forageState.checkResult}) war 5+ unter DC ({forageState.dc}).<br/>Zufallsbegegnung oder Vergiftung möglich.</span>
                                        </div>
                                    ) : (
                                        <>
                                            {forageState.foodFound > 0 || forageState.waterFound > 0 ? (
                                                <div className="text-good font-bold">
                                                    <div className="text-3xl mb-2">🌿</div>
                                                    Erfolg!<br/>
                                                    {forageState.checkResult === 999 && <span className="text-xs text-accent mb-2 block">(Automatisch / Feature)</span>}
                                                    <div className="mt-2 grid grid-cols-2 gap-4 text-white">
                                                        <div className="bg-bg-secondary p-2 rounded">
                                                            <div className="text-xs text-muted">Essen gefunden:</div>
                                                            <div className="text-xl">{forageState.foodFound} lb</div>
                                                        </div>
                                                        <div className="bg-bg-secondary p-2 rounded">
                                                            <div className="text-xs text-muted">Wasser gefunden:</div>
                                                            <div className="text-xl">{forageState.waterFound} gal</div>
                                                        </div>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="text-muted">
                                                    <div className="text-3xl mb-2">🍂</div>
                                                    Nichts gefunden.<br/>
                                                    <span className="text-sm">Check ({forageState.checkResult}) hat DC ({forageState.dc}) nicht erreicht.</span>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>

                                {(forageState.foodFound > 0 || forageState.waterFound > 0) && !forageState.mishap && (
                                    <div className="space-y-4 mb-4 text-left">
                                        
                                        {/* Food Storage Section */}
                                        {forageState.foodFound > 0 && (
                                            <div className="bg-glass p-3 rounded-lg border border-border-color">
                                                <label className="text-sm font-bold block mb-2 text-white">🍔 Essen einlagern ({forageState.foodFound} lb)</label>
                                                {getAvailableStorages('food_feed').length > 0 ? (
                                                    <div className="flex gap-2">
                                                        <select 
                                                            value={forageState.selectedFoodStoreId} 
                                                            onChange={e => setForageState(prev => ({...prev, selectedFoodStoreId: e.target.value}))} 
                                                            className="flex-grow bg-bg-secondary text-white p-2 rounded text-sm border border-border-color focus:border-accent outline-none appearance-none cursor-pointer"
                                                        >
                                                            {getAvailableStorages('food_feed').map(s => {
                                                                const load = s.food + (s.feed||0);
                                                                const space = s.maxCapacity - load;
                                                                return <option key={s.id} value={s.id}>{s.name} (Frei: {space}lb)</option>
                                                            })}
                                                        </select>
                                                        <button onClick={storeFood} className="bg-good text-bg-secondary font-bold px-3 py-1 rounded text-sm">OK</button>
                                                    </div>
                                                ) : (
                                                    <div className="text-xs text-bad">Kein geeignetes Lager verfügbar (alle voll oder inaktiv).</div>
                                                )}
                                            </div>
                                        )}

                                        {/* Water Storage Section */}
                                        {forageState.waterFound > 0 && (
                                            <div className="bg-glass p-3 rounded-lg border border-border-color">
                                                <label className="text-sm font-bold block mb-2 text-white">💧 Wasser einlagern ({forageState.waterFound} gal)</label>
                                                {getAvailableStorages('water').length > 0 ? (
                                                    <div className="flex gap-2">
                                                        <select 
                                                            value={forageState.selectedWaterStoreId} 
                                                            onChange={e => setForageState(prev => ({...prev, selectedWaterStoreId: e.target.value}))} 
                                                            className="flex-grow bg-bg-secondary text-white p-2 rounded text-sm border border-border-color focus:border-accent outline-none appearance-none cursor-pointer"
                                                        >
                                                            {getAvailableStorages('water').map(s => {
                                                                const space = s.maxCapacity - s.water;
                                                                return <option key={s.id} value={s.id}>{s.name} (Frei: {space}gal)</option>
                                                            })}
                                                        </select>
                                                        <button onClick={storeWater} className="bg-accent text-bg-secondary font-bold px-3 py-1 rounded text-sm">OK</button>
                                                    </div>
                                                ) : (
                                                    <div className="text-xs text-bad">Kein geeignetes Lager verfügbar (alle voll oder inaktiv).</div>
                                                )}
                                            </div>
                                        )}

                                    </div>
                                )}

                                <div className="flex gap-2 flex-col">
                                    {(forageState.foodFound > 0 || forageState.waterFound > 0) && !forageState.mishap ? (
                                         <button onClick={discardRemainingForage} className="w-full bg-transparent border border-bad/50 text-bad text-sm py-2 rounded-lg hover:bg-bad/10">Rest wegwerfen & Schließen</button>
                                    ) : (
                                        <button onClick={() => setForageState(prev => ({...prev, step: 'idle'}))} className="w-full bg-accent text-bg-secondary font-bold py-2 rounded-lg">Schließen</button>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            <div className="space-y-4">
                <div className="bg-card rounded-xl p-4 shadow-lg">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-xl font-bold">Verbraucher</h3>
                        <div className="flex items-center gap-2">
                             <button 
                                onClick={() => setIsHotWeather(!isHotWeather)} 
                                className={`text-xs px-2 py-1 rounded border transition-colors ${isHotWeather ? 'bg-orange-500/20 text-orange-400 border-orange-500' : 'bg-transparent text-muted border-border-color'}`}
                                title="Verdoppelt Wasserbedarf"
                            >
                                {isHotWeather ? '☀️ Heiß' : '☁️ Normal'}
                            </button>
                            <button onClick={addCreature} className="text-xs bg-glass hover:bg-white/10 px-2 py-1 rounded border border-border-color">+ Neu</button>
                        </div>
                    </div>
                    
                    <div className="space-y-2">
                        {creatures.map(c => (
                            <div key={c.id} className="grid grid-cols-[auto,1fr,auto,80px,30px] gap-2 items-center bg-glass p-2 rounded">
                                <div className="flex flex-col gap-0.5 min-w-[30px]">
                                    {c.daysWithoutFood > 0 && <span className="text-[10px] text-white bg-orange-500/50 px-1 rounded text-center" title="Tage ohne Essen">🍔{c.daysWithoutFood}</span>}
                                    {c.exhaustion > 0 && <span className="text-[10px] text-white bg-bad px-1 rounded text-center" title="Erschöpfungs-Level">💀{c.exhaustion}</span>}
                                </div>
                                
                                <div>
                                    <input className="bg-transparent border-b border-border-color focus:border-accent outline-none text-sm w-full text-white" value={c.name} onChange={e => updateCreature(c.id, 'name', e.target.value)} placeholder="Name" />
                                    <div className="flex items-center gap-2 mt-1">
                                         <label className="text-[10px] text-muted flex items-center gap-1">
                                            Con Mod:
                                            <input type="number" value={c.conMod || 0} onChange={e => handleNumberChange(c.id, 'conMod', e.target.value, setCreatures, creatures)} className="w-8 h-4 bg-input-bg text-center rounded border-none text-[10px]" />
                                        </label>
                                    </div>
                                </div>
                                
                                <button 
                                    onClick={() => updateCreature(c.id, 'usesFeed', !c.usesFeed)}
                                    className={`p-1.5 rounded transition-colors ${c.usesFeed ? 'bg-yellow-600 text-white' : 'bg-input-bg text-muted hover:bg-white/10'}`}
                                    title={c.usesFeed ? "Verbraucht Tierfutter" : "Verbraucht normale Rationen"}
                                >
                                    🐾
                                </button>

                                <select className="bg-bg-secondary text-xs rounded p-1 border border-border-color text-white" value={c.size} onChange={e => updateCreature(c.id, 'size', e.target.value as CreatureSize)}>
                                    {Object.keys(CONSUMPTION_RATES).map(size => <option key={size} value={size}>{size}</option>)}
                                </select>
                                
                                <button onClick={() => removeCreature(c.id)} className="text-muted hover:text-bad">×</button>
                            </div>
                        ))}
                        {creatures.length === 0 && <div className="text-muted text-sm italic p-2">Keine Einträge.</div>}
                    </div>
                </div>

                <div className="bg-card rounded-xl p-4 shadow-lg border border-border-color">
                    <h3 className="text-lg font-bold mb-3">Tagesabschluss</h3>
                    <div className="flex justify-between text-sm mb-1">
                        <span className="text-muted">Bedarf (Tag):</span>
                        <div className="text-right">
                           <div className="whitespace-nowrap">🍔 {totalNeeds.food.toFixed(2)} lb</div>
                           <div className="whitespace-nowrap">🌾 {totalNeeds.feed.toFixed(2)} U</div>
                           <div className="whitespace-nowrap">💧 {totalNeeds.water.toFixed(2)} gal</div>
                        </div>
                    </div>
                    <div className="h-px bg-border-color my-2"></div>
                    <div className="flex justify-between text-sm mb-4">
                        <span className="text-muted">Vorrat (Aktiv):</span>
                        <div className="text-right">
                           <div className={totalStored.food < totalNeeds.food ? 'text-bad' : 'text-good'}>🍔 {totalStored.food.toFixed(2)} lb</div>
                           <div className={totalStored.feed < totalNeeds.feed ? 'text-bad' : 'text-good'}>🌾 {totalStored.feed.toFixed(2)} U</div>
                           <div className={totalStored.water < totalNeeds.water ? 'text-bad' : 'text-good'}>💧 {totalStored.water.toFixed(2)} gal</div>
                        </div>
                    </div>
                    
                    <div className="space-y-2">
                        <button onClick={openRationingModal} disabled={creatures.length === 0} className="w-full bg-gradient-to-r from-orange-500 to-red-500 text-white font-bold py-3 px-4 rounded-lg shadow-md hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed">
                            Tagesration verbrauchen
                        </button>
                        
                        {consumptionMsg && (
                            <div className="p-2 bg-good/20 border border-good/50 text-good rounded text-center text-sm animate-pulse">
                                {consumptionMsg}
                            </div>
                        )}
                        
                        {lastStoragesState && (
                            <button onClick={handleUndo} className="w-full bg-transparent border border-border-color text-muted py-2 px-4 rounded-lg hover:bg-glass hover:text-white transition-all text-sm flex items-center justify-center gap-2">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
                                Widerrufen
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div className="bg-card rounded-xl p-4 shadow-lg h-fit">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold">Lager & Vorräte</h3>
                    <div className="flex gap-2">
                         <button onClick={startForaging} className="text-xs bg-gradient-to-r from-green-600 to-green-700 text-white font-bold px-2 py-1 rounded border border-transparent shadow-sm hover:opacity-90">🌿 Suchen</button>
                        <button onClick={addStorage} className="text-xs bg-glass hover:bg-white/10 px-2 py-1 rounded border border-border-color">+ Lager</button>
                    </div>
                </div>

                <div className="space-y-3">
                    {storages.map(s => {
                        const currentLoad = s.storageType === 'water' ? s.water : (s.food + (s.feed||0));
                        const isFull = currentLoad >= s.maxCapacity;
                        
                        return (
                            <div key={s.id} className={`bg-glass p-3 rounded-lg border border-transparent hover:border-border-color transition-all ${!s.isActive ? 'opacity-50 grayscale' : ''}`}>
                                <div className="flex justify-between items-center mb-2">
                                    <div className="flex items-center gap-2 flex-grow mr-2">
                                        <button 
                                            onClick={() => updateStorage(s.id, 'isActive', !s.isActive)}
                                            className={`p-1 rounded text-xs border ${s.isActive ? 'bg-good/20 text-good border-good/30' : 'bg-transparent text-muted border-border-color'}`}
                                            title={s.isActive ? "Lager wird verwendet" : "Lager wird ignoriert"}
                                        >
                                            {s.isActive ? 'Aktiv' : 'Inaktiv'}
                                        </button>
                                        <input className="font-bold bg-transparent border-b border-transparent focus:border-accent outline-none w-full text-white" value={s.name} onChange={e => updateStorage(s.id, 'name', e.target.value)} placeholder="Lager Name" />
                                    </div>
                                    <button onClick={() => removeStorage(s.id)} className="text-muted hover:text-bad">×</button>
                                </div>
                                
                                <div className="mb-2 flex items-center gap-2 text-xs">
                                    <div className="flex bg-input-bg rounded p-1 border border-border-color">
                                        <button onClick={() => handleStorageTypeChange(s.id, 'food_feed')} className={`px-2 py-0.5 rounded ${s.storageType === 'food_feed' ? 'bg-accent text-bg-secondary font-bold' : 'text-muted'}`}>Essen/Futter</button>
                                        <button onClick={() => handleStorageTypeChange(s.id, 'water')} className={`px-2 py-0.5 rounded ${s.storageType === 'water' ? 'bg-accent text-bg-secondary font-bold' : 'text-muted'}`}>Wasser</button>
                                    </div>
                                    <div className="flex-grow text-right text-muted">
                                        Kapazität: <input type="number" value={s.maxCapacity} onChange={e => handleNumberChange(s.id, 'maxCapacity', e.target.value, setStorages, storages)} className="w-12 bg-transparent border-b border-border-color text-right focus:border-accent text-white" /> {s.storageType === 'water' ? 'gal' : 'lb'}
                                    </div>
                                </div>

                                {/* Capacity Bar */}
                                <div className="w-full bg-input-bg h-1.5 rounded-full overflow-hidden mb-3">
                                    <div 
                                        className={`h-full ${isFull ? 'bg-bad' : 'bg-good'} transition-all duration-300`} 
                                        style={{ width: `${Math.min(100, (currentLoad / s.maxCapacity) * 100)}%` }}
                                    ></div>
                                </div>

                                <div className="grid grid-cols-2 gap-2">
                                    {s.storageType === 'food_feed' ? (
                                        <>
                                            <div>
                                                <label className="text-xs text-muted block mb-1">Essen (lb)</label>
                                                <input 
                                                    type="number" 
                                                    step="0.1" 
                                                    className="w-full bg-input-bg rounded p-1.5 text-sm border border-border-color focus:border-accent text-white" 
                                                    value={s.food} 
                                                    onChange={e => handleNumberChange(s.id, 'food', e.target.value, setStorages, storages)}
                                                />
                                            </div>
                                            <div>
                                                <label className="text-xs text-muted block mb-1">Futter (Unit)</label>
                                                <input 
                                                    type="number" 
                                                    step="0.1" 
                                                    className="w-full bg-input-bg rounded p-1.5 text-sm border border-border-color focus:border-accent text-white" 
                                                    value={s.feed || 0} 
                                                    onChange={e => handleNumberChange(s.id, 'feed', e.target.value, setStorages, storages)}
                                                />
                                            </div>
                                        </>
                                    ) : (
                                         <div className="col-span-2">
                                            <label className="text-xs text-muted block mb-1">Wasser (gal)</label>
                                            <input 
                                                type="number" 
                                                step="0.1" 
                                                className="w-full bg-input-bg rounded p-1.5 text-sm border border-border-color focus:border-accent text-white" 
                                                value={s.water} 
                                                onChange={e => handleNumberChange(s.id, 'water', e.target.value, setStorages, storages)}
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                    {storages.length === 0 && <div className="text-muted text-sm italic text-center p-4">Keine Lager definiert.</div>}
                </div>
            </div>
        </div>
    );
};


// ==========================================
// MAIN APP
// ==========================================

const App: React.FC = () => {
    const [activeTab, setActiveTab] = useState<'encounters' | 'resources'>('encounters');
    const [log, setLog] = useState<string[]>(['Optimiertes Tool geladen.']);
    const [result, setResult] = useState<string>('Keine Würfe bisher.');
    const [currentFlow, setCurrentFlow] = useState<FlowState | null>(null);
    
    // Modal State
    const [modalConfig, setModalConfig] = useState<ModalConfig>({
        isOpen: false,
        type: 'alert',
        title: '',
        message: ''
    });

    const triggerModal = (type: ModalType, title: string, message: React.ReactNode, onConfirm?: () => void) => {
        setModalConfig({
            isOpen: true,
            type,
            title,
            message,
            onConfirm
        });
    };

    const loadData = <T,>(key: string, defaultValue: T): T => {
        try {
            const item = localStorage.getItem(`enc_${key}`);
            return item ? JSON.parse(item) : defaultValue;
        } catch (error) {
            console.warn(`Error reading localStorage key “${key}”:`, error);
            return defaultValue;
        }
    };

    const [settings, setSettings] = useState<Settings>(() => loadData<Settings>('state', {
        terrain: 'road',
        pace: 'normal',
        vehicle: 'no',
        watchCount: 3,
        lightHours: 0,
        watches: Array(3).fill({ name: '', vision: 'none', pp: 12 })
    }));

    const [matrix, setMatrix] = useState<Matrix>(() => loadData<Matrix>('matrix', JSON.parse(JSON.stringify(DEFAULTS))));

    // --- Resource State ---
    const [creatures, setCreatures] = useState<Creature[]>(() => {
        const loaded = loadData<any[]>('creatures', [
            { id: '1', name: 'Pferd', size: 'Large', usesFeed: true, conMod: 2, daysWithoutFood: 0, exhaustion: 0 },
            { id: '2', name: 'Abenteurer', size: 'Medium', usesFeed: false, conMod: 1, daysWithoutFood: 0, exhaustion: 0 }
        ]);
        // Data Migration: Add new fields if missing in LocalStorage
        return loaded.map(c => ({
            ...c,
            conMod: c.conMod ?? 0,
            daysWithoutFood: c.daysWithoutFood ?? 0,
            exhaustion: c.exhaustion ?? 0
            // count property is simply ignored if present in old data
        }));
    });
    
    const [storages, setStorages] = useState<Storage[]>(() => {
        const loaded = loadData<any[]>('storages', [
            { id: '1', name: 'Wagen (Essen)', isActive: true, storageType: 'food_feed', maxCapacity: 200, food: 50, water: 0, feed: 7 },
            { id: '2', name: 'Wasserfass', isActive: true, storageType: 'water', maxCapacity: 50, food: 0, water: 20, feed: 0 }
        ]);
        // Data Migration
        return loaded.map(s => ({
            ...s,
            isActive: s.isActive ?? true,
            storageType: s.storageType || 'food_feed', // Default for old data
            maxCapacity: s.maxCapacity || 100
        }));
    });

    useEffect(() => { localStorage.setItem('enc_state', JSON.stringify(settings)); }, [settings]);
    useEffect(() => { localStorage.setItem('enc_matrix', JSON.stringify(matrix)); }, [matrix]);
    useEffect(() => { localStorage.setItem('enc_creatures', JSON.stringify(creatures)); }, [creatures]);
    useEffect(() => { localStorage.setItem('enc_storages', JSON.stringify(storages)); }, [storages]);
    
    const addLog = (msg: string) => setLog(prev => [`${new Date().toLocaleTimeString()} — ${msg}`, ...prev]);
    const resetLog = () => { setLog([]); setResult('Log geleert.'); setCurrentFlow(null); };

    const resetAll = () => {
        triggerModal('confirm', 'Alles zurücksetzen', 'Möchtest du wirklich alle Einstellungen, die Matrix und die Ressourcen-Daten zurücksetzen?', () => {
            localStorage.removeItem('enc_state');
            localStorage.removeItem('enc_matrix');
            // Not deleting creatures/storages unless explicitly managed, but here we reset settings
            setSettings({
                terrain: 'road', pace: 'normal', vehicle: 'no', watchCount: 3, lightHours: 0,
                watches: Array(3).fill(null).map((_, i) => ({ name: `Wache ${i + 1}`, vision: 'none', pp: 12 }))
            });
            setMatrix(JSON.parse(JSON.stringify(DEFAULTS)));
            addLog('Alle Einstellungen zurückgesetzt.');
        });
    };

    const handleTravelRoll = () => {
        resetLog();
        addLog('--- TRAVEL ROLL START ---');
        const terrainKey = settings.terrain;
        const terrainName = TERRAIN_MAP[terrainKey];
        const ranges = matrix.day[terrainName];
        const d = rnd(100);
        addLog(`Travel d100 → ${d} (${terrainName})`);
        addLog(`Bereiche: Hostile ${ranges.hostile[0]}-${ranges.hostile[1]}, Neutral ${ranges.neutral[0]}-${ranges.neutral[1]}, POI ${ranges.poi[0]}-${ranges.poi[1]}`);

        let encType: EncounterTypeKey | 'poi' | null = null;
        if (d >= ranges.hostile[0] && d <= ranges.hostile[1] && ranges.hostile[0] > 0) encType = 'hostile';
        else if (d >= ranges.neutral[0] && d <= ranges.neutral[1] && ranges.neutral[0] > 0) encType = 'neutral';
        else if (d >= ranges.poi[0] && d <= ranges.poi[1] && ranges.poi[0] > 0) encType = 'poi';

        if (!encType) { setResult('Keine Begegnung.'); return; }
        if (encType === 'poi') { setResult(`POI entdeckt! (d100 ${d})`); addLog('POI — sofort sichtbar.'); return; }

        setResult(`Encounter: ${encType.toUpperCase()} (d100 ${d}) → Stealth-Mechanik startet...`);
        setCurrentFlow({ step: 'enemyStealthChoice', context: 'day', encounterType: encType, d, terrain: terrainKey, vehicle: settings.vehicle === 'yes' });
    };
    
    const handleRestRoll = () => {
        resetLog();
        addLog('--- LONG REST ROLL START ---');
        const terrainKey = settings.terrain;
        const terrainName = TERRAIN_MAP[terrainKey];
        const nightInfo = matrix.night[terrainName];
        
        const baseThreshold = Math.max(nightInfo.basis[0], nightInfo.basis[1]);
        const threshold = baseThreshold + (settings.lightHours * nightInfo.light);
        const d = rnd(100);
        addLog(`Long Rest d100 → ${d} (Schwelle: ${threshold} | Basis: ${baseThreshold}, Licht: ${settings.lightHours}h * ${nightInfo.light})`);
    
        if (d > threshold) { setResult('Keine Begegnung während der langen Rast.'); return; }
    
        const watchRoll = rnd(settings.watches.length);
        const affectedWatch = settings.watches[watchRoll - 1];
        let effectivePP = affectedWatch.pp;
        let modifier = 'Normal';
        if (affectedWatch.vision === 'none') { effectivePP = Math.floor(affectedWatch.pp / 2); modifier = 'PP halbiert (kein Darkvision)'; } 
        else if (affectedWatch.vision === 'darkvision') { modifier = 'Nachteil auf aktive Checks'; }
    
        addLog(`Begegnung! Betroffene Wache: ${affectedWatch.name} (Wurf ${watchRoll}/${settings.watches.length})`);
        setResult(`Nacht-Encounter: ${affectedWatch.name}!`);
        setCurrentFlow({
            step: 'nightEncounterInfo', context: 'night', encounterType: 'hostile', d, terrain: terrainKey, affectedWatch,
            watchPerception: { effectivePP, modifier }
        });
    };

    return (
        <main className="min-h-screen p-4 md:p-7 pb-20">
            <Modal config={modalConfig} onClose={() => setModalConfig({...modalConfig, isOpen: false})} />

            <div className="max-w-7xl mx-auto">
                <header className="mb-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <div>
                        <h1 className="text-2xl font-bold">Random Encounters</h1>
                        <p className="text-muted text-sm">Spieltisch-Tool & Ressourcen-Tracker</p>
                    </div>
                    <div className="flex bg-card p-1 rounded-lg border border-border-color">
                        <button onClick={() => setActiveTab('encounters')} className={`px-4 py-2 rounded-md text-sm font-bold transition-all ${activeTab === 'encounters' ? 'bg-accent text-bg-secondary shadow-md' : 'text-muted hover:text-white'}`}>🎲 Begegnungen</button>
                        <button onClick={() => setActiveTab('resources')} className={`px-4 py-2 rounded-md text-sm font-bold transition-all ${activeTab === 'resources' ? 'bg-accent text-bg-secondary shadow-md' : 'text-muted hover:text-white'}`}>🍎 Ressourcen</button>
                    </div>
                </header>
                
                {activeTab === 'encounters' ? (
                    <>
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                            <div className="lg:col-span-2 flex flex-col gap-4">
                               <SettingsCard settings={settings} setSettings={setSettings} onTravelRoll={handleTravelRoll} onRestRoll={handleRestRoll} onResetAll={resetAll} />
                            </div>
                            <LogCard log={log} result={result} onResetLog={resetLog} />
                        </div>
                        {currentFlow && <FlowPanels flowState={currentFlow} setFlowState={setCurrentFlow} setResult={setResult} addLog={addLog} triggerModal={triggerModal} />}
                        <MatrixEditor matrix={matrix} setMatrix={setMatrix} addLog={addLog} triggerModal={triggerModal} />
                    </>
                ) : (
                    <ResourceManager creatures={creatures} setCreatures={setCreatures} storages={storages} setStorages={setStorages} addLog={addLog} triggerModal={triggerModal} settings={settings} />
                )}
            </div>
        </main>
    );
};

// ==========================================
// RENDER
// ==========================================

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error("Could not find root element to mount to");

const root = ReactDOM.createRoot(rootElement);
root.render(<React.StrictMode><App /></React.StrictMode>);