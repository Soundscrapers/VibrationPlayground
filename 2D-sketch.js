/**
 * 2D-sketch.js
 *
 * Responsibility:
 * - Owns time and dt
 * - Orchestrates physics, interaction, and observers
 *
 * NOT allowed:
 * - Physics equations
 * - Rendering logic
 * - Sound logic
 */
// iOS Safari workaround
document.addEventListener("touchstart", {});
let modalState;
let mdof;
let interaction;
let visualObserver;
let soundObserver;
// world = 'mdof' or 'string'. Set from preset on load and on every reset.
let world = 'mdof';
let stringDef;         // StringDefinition instance (single string world only)
let stringScreenGeom;  // { xLeft, xRight, Lx, yCenter, yScale } (single string world only)
// Multi-string world: array of per-string bundles.
// Each element: { def: StringDefinition, state: ModalState, sound: null,
//                 yCenter: number, color: [r,g,b], cooldown: number }
// strings[0] = lowest pitch (bottom), strings[count-1] = highest (top).
let strings = [];
// Shared screen geometry for multi-string: { xLeft, xRight, Lx, yScale, velocityGain }.
// All strings share the same horizontal span; each string has its own yCenter.
let stringSharedGeom;
// temporal control
const FR = 60;
let baseDt;
let timeScale = 1.0;
let isFrozen = false;
let forcingTime = 0;  // clock for KinematicTool sinusoidal trajectories

// Modal forcing state.
// Mechanism: applied harmonic force f(t) = AMP*sin(omega*t) on one mass.
//   ModalState.setForcing() computes the particular + homogeneous response each step.
//   The forced mass remains dynamically FREE -- it oscillates in response to the force,
//   not on a prescribed trajectory. Transient homogeneous solution coexists with the
//   particular (steady-state) solution.
// Distinct from KinematicTool ('k' key) which prescribes displacement directly.
// Toggle: 'f' key. Targets the outermost right mass. Frequency nudgeable UP/DOWN.
let modalForcingActive = false;
let modalForcingIdx    = -1;   // physics index of the forced mass; -1 when inactive
let   MODAL_FORCE_AMP  = 1.0;  // peak force in Newtons (physical, not displacement); adjustable via UI
const MODAL_FORCE_OMEGA_DEFAULT = 2 * Math.PI * 1.0;
let   modalForcingOmega = MODAL_FORCE_OMEGA_DEFAULT;
// UI stuff
let isMuted;
// Dimensions and scaling
let dims;
// MassLayout: single source of truth for visual geometry
let massLayout;
// Store preset for reset
let storedPresetJSON;

// --- Helper mode state ---
// _lastAction:   most recent named canvas interaction; consumed (nulled) after one VP_STATE frame.
// _lastScenario: name of the most recently loaded scenario; persists until next scenario loads.
// _dragOccurred: set true in mouseDragged; used in mouseReleased to classify tap vs drag.
let _lastAction   = null;
let _lastScenario = null;
let _dragOccurred = false;

// _stringColor(i, count) -- compute [r,g,b] for string index i of count strings.
//
// Interpolates HSB from purple (hue 270, i=0 = lowest) to green (hue 140,
// i=count-1 = highest). Hue goes directly 270 -> 140 (subtracting 130 degrees)
// to avoid crossing the red sector.
//
// t = 0 (lowest string) --> hue 270 (purple)
// t = 1 (highest string) --> hue 140 (green)
// saturation = 70%, brightness = 85%.
//
// HSB to RGB conversion uses the standard sector formula:
//   C = B * S (chroma),  H' = hue/60 (sector),  X = C*(1 - |H' mod 2 - 1|)
//
// @param {number} i     -- string index (0 = lowest pitch, count-1 = highest)
// @param {number} count -- total number of strings
// @returns {Array} [r, g, b] -- each in [0, 255]
function _stringColor(i, count) {
  // t: 0 = bottom/lowest (purple), 1 = top/highest (green).
  // For a single string, center at t=0.5 (blue-ish).
  const t    = (count <= 1) ? 0.5 : i / (count - 1);
  const hDeg = 270 - 130 * t;  // hue in degrees: 270 (purple) -> 140 (green)
  const sat  = 0.70;
  const bri  = 0.85;

  // Normalize hue to [0, 360) and find the sector (H' in [0, 6)).
  const hNorm = ((hDeg % 360) + 360) % 360;
  const hSect = hNorm / 60;
  const C = bri * sat;                             // chroma
  const X = C * (1 - Math.abs((hSect % 2) - 1));  // intermediate value

  // Sector -> (r1, g1, b1) before adding the lightness adjustment m.
  let r1, g1, b1;
  const h_ = Math.floor(hSect);
  if      (h_ === 0) { r1 = C; g1 = X; b1 = 0; }
  else if (h_ === 1) { r1 = X; g1 = C; b1 = 0; }
  else if (h_ === 2) { r1 = 0; g1 = C; b1 = X; }
  else if (h_ === 3) { r1 = 0; g1 = X; b1 = C; }
  else if (h_ === 4) { r1 = X; g1 = 0; b1 = C; }
  else               { r1 = C; g1 = 0; b1 = X; }

  const m = bri - C;  // add m to each channel to get final brightness
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255)
  ];
}

function setup() {
  // Compute canvas size and scaling factor.
  // Use full browser width up to maxWidth (no longer constrained by innerHeight).
  const maxWidth = 1000; // reference size for s=1
  // Subtract the sidebar width so the canvas fits beside #vp-tools in the flex row.
  // Menu.js _buildSidebar() runs on DOMContentLoaded (before setup()), so
  // offsetWidth is valid here. Falls back to 0 if no sidebar is present.
  const sidebarEl = document.getElementById('vp-tools');
  const sidebarW  = sidebarEl ? sidebarEl.offsetWidth : 0;
  const canvasWidth  = min(innerWidth, maxWidth) - sidebarW;
  const canvasHeight = 0.75 * canvasWidth; // 4:3 aspect ratio
  const s = canvasWidth / maxWidth; // scaling factor (slightly < 1 when sidebar is present)

  createCanvas(canvasWidth, canvasHeight).parent('canvas-container');

  // Pin the outer container to the full workspace width (sidebar + canvas)
  // so the control panel below matches the combined width.
  const outer = document.getElementById('vp-outer');
  if (outer) outer.style.width = (canvasWidth + sidebarW) + 'px';
  frameRate(FR);
  baseDt = 1 / FR;
  
  // Hide default cursor - we'll draw our own
  noCursor();

  // ---------------------------------------------------------------
  // Arc geometry: "zoomed-in" view of a larger resonating system.
  //
  // The center of all arc-circles lives one radiusGap off the right
  // edge of the canvas.  baseRadius = 4 * radiusGap.
  //
  // Symmetry condition: arc 0's equilibrium point is 3*gap from the
  // right edge.  Arc N-1's equilibrium is at x = cw - (N+2)*gap from
  // the left edge.  Setting these equal:
  //
  //   3*gap = cw - (N+2)*gap   →   gap = cw / (N+5)
  //
  // where N = maxMasses (16).  This guarantees the outermost arc's
  // equilibrium is the same distance from the left edge as the
  // innermost arc's equilibrium is from the right edge.
  // ---------------------------------------------------------------
  const maxMasses = 16;
  const radiusGap = canvasWidth / (maxMasses + 5);
  // centerX / centerY removed: dead code, all geometry comes from massLayout.

  const baseRadius = radiusGap * 4;

  // Buffer: arcs extend this far beyond the canvas edges before clipping.
  // Prevents hard visual cutoffs at the boundary.
  const clipBuffer = 30 * s;

  // Package all scaled dimensions
  dims = {
    s: s,
    baseRadius: baseRadius,
    radiusGap: radiusGap,
    endCircleRadius: 6 * s,
    arcStrokeWeight: 3 * s,
    couplingStrokeWeight: max(1, 1 * s), // min 1px for visibility
    canvasWidth: canvasWidth,
    canvasHeight: canvasHeight,
    clipBuffer: clipBuffer,
    maxPerSide: maxMasses / 2,  // hard cap per side for MassLayout.addMass()
    bgColor: 30,                // canvas background gray value (0=black, 255=white)
  };
  // Load preset (could come from URL param, embedded script, or default)
  storedPresetJSON = window.VIBRATION_PRESET || PresetLoader.DEFAULT;
  window.storedPresetJSON = storedPresetJSON; // Make accessible to parent window
  const preset = PresetLoader.load(storedPresetJSON);

  // Settings shared by all worlds
  world     = preset.world;
  isMuted   = preset.soundMuted;
  timeScale = preset.timeScale;
  isFrozen  = preset.timeFrozen;

  if (world === 'mdof') {
    // Initialize MDOF physics, layout, observers
    mdof = preset.definition;
    modalState = new ModalState(mdof);
    modalState.setPhysicalState(preset.initialX, preset.initialV);

    // Build MassLayout: maps physics indices to visual arc positions.
    // Must come after mdof is built. All tools and observers read from this.
    massLayout = new MassLayout(dims);
    massLayout.rebuild(mdof);
    window.massLayout = massLayout;  // panel and tools read via global

    visualObserver = new MassVisualObserver(dims);
    soundObserver  = new MassSoundObserver(dims);
    window.soundObserver = soundObserver;  // expose for index.html sound panel sliders
    interaction = new MassInteractionController({
      ...dims,
      mdof: mdof,
      modalState: modalState,
      soundObserver: soundObserver,  // so ensureAudioStarted() can init audio graph once
      defaultK: 50,
    });
    window.interaction = interaction;  // expose for index.html panel JS

    // Register mass world config with Menu.js so it populates tab content.
    // vpBuildMenu is defined by Menu.js which loads before sketch.js.
    if (window.vpBuildMenu) {
      vpBuildMenu({
        world:     'mass',
        tools:     { hold: true },
        scenarios: [
          { label: '2 coupled',   scene: '2coupled'  },
          { label: 'absorber',    scene: 'absorber'   },
          { label: '16 coupled',  scene: 'coupled16'  },
          { label: '16 grounded', scene: 'grounded16' },
          { label: 'wave',        scene: 'wave'       },
        ],
      });
    }

  } else if (world === 'string') {
    // Initialize string physics, screen geometry, observers
    stringDef  = preset.definition;
    // setup() always starts fresh -- set string damping default and sync slider.
    dampingBase = 0.1;
    const sl = document.getElementById('slider-zeta');
    const vl = document.getElementById('val-zeta');
    if (sl) sl.value = 0.1;
    if (vl) vl.textContent = '0.100';
    stringDef.setDamping(dampingBase);
    modalState = new ModalState(stringDef);
    modalState.setPhysicalState(preset.initialX, preset.initialV);

    // Screen geometry: maps physical string coordinates to canvas pixels.
    //
    // Endpoints are aligned with the outermost MDOF arc equilibrium positions
    // so the string sits inside the same spatial footprint as the mass world.
    //
    // From MassLayout geometry:
    //   eqX = midX +/- (maxK + 0.5) * radiusGap
    //   where maxK = maxPerSide - 1  (steps from innermost to outermost)
    //
    // velocityGain: amplifies cursor-based strike velocity for string world.
    // Without gain, v0 = (yOffset / yScale) is tiny in m/s relative to c=2 m/s,
    // giving an invisible wave. Gain of 40 makes 100px clicks produce ~20 m/s.
    const maxK   = dims.maxPerSide - 1;
    const midX   = dims.canvasWidth / 2;
    const xLeft  = midX - (maxK + 0.5) * dims.radiusGap;
    const xRight = midX + (maxK + 0.5) * dims.radiusGap;
    stringScreenGeom = {
      xLeft,
      xRight,
      Lx:          xRight - xLeft,
      yCenter:     dims.canvasHeight / 2,
      yScale:      dims.canvasHeight * 0.30,
      velocityGain: 20   // amplifies cursor strikes; see StrikeTool.pointerDown()
    };

    visualObserver = new StringVisualObserver(dims, stringDef, stringScreenGeom);
    soundObserver  = new StringSoundObserver(dims, stringDef);
    interaction    = new StringInteractionController({
      stringDef, modalState,
      soundObserver,
      screenGeom: stringScreenGeom
    });
    window.interaction = interaction;

    // Register single-string world config with Menu.js.
    if (window.vpBuildMenu) {
      vpBuildMenu({
        world:     'string',
        tools:     { hold: true },  // hold splits the string at a node
        scenarios: []               // no discrete scenarios for single-string
      });
    }

  } else if (world === 'strings') {
    // ---- Multi-string world ----
    // setup() is the initial load: always reset dampingBase to the string default.
    dampingBase = 0.1;
    _initMultiStrings(preset);

    // Register multi-string world config with Menu.js.
    // Scenarios appear in the flyout; strum button auto-appears via _syncContextualButtons.
    if (window.vpBuildMenu) {
      vpBuildMenu({
        world:     'strings',
        tools:     { hold: true },
        scenarios: [
          { label: 'Solo',        scene: 'solo'    },
          { label: 'Fourier',     scene: 'fourier' },
          { label: 'Quintet',     scene: 'quintet' },
          { label: 'Full Spread', scene: 'full'    },
        ]
      });
    }
  }
}

// _initMultiStrings(preset) -- build strings[], stringSharedGeom, visualObserver,
// and interaction for the multi-string world.
//
// Extracted from setup() so resetToPreset() can call the same logic.
// Sets the following globals: strings, stringSharedGeom, visualObserver,
// soundObserver (null in Step 1), interaction.
//
// @param {Object} preset -- return value from PresetLoader.load() with world='strings'
function _initMultiStrings(preset) {
  const count = preset.stringBundles.length;

  // Shared horizontal span: same formula as single-string world so the string
  // endpoints align with the outermost MDOF arc equilibrium positions.
  const maxK   = dims.maxPerSide - 1;
  const midX   = dims.canvasWidth  / 2;
  const xLeft  = midX - (maxK + 0.5) * dims.radiusGap;
  const xRight  = midX + (maxK + 0.5) * dims.radiusGap;

  // Vertical layout.
  // topPad / bottomPad (logical pixels * s): room for labels and panels.
  // usableHeight = canvas height minus both pads.
  //
  // Spacing is fixed at usableH / 8 (the 9-string full-spread gap) regardless
  // of count, so Solo, Quintet, and Full Spread all share identical string
  // separation. Smaller presets are centered within the usable area.
  //
  // groupBottom: canvas y of the lowest string in the centered group.
  //   totalSpan  = (count-1) * spacing
  //   groupBottom = canvasHeight - bottomPad - (usableH - totalSpan) / 2
  const topPad    = 80 * dims.s;
  const bottomPad = 80 * dims.s;
  const usableH   = dims.canvasHeight - topPad - bottomPad;
  const spacing   = usableH / 8;   // fixed: same gap as 9-string full spread
  const totalSpan  = (count > 1) ? (count - 1) * spacing : 0;
  const groupBottom = dims.canvasHeight - bottomPad - (usableH - totalSpan) / 2;

  // yScale: allow strings to reach the adjacent string's center line when vibrating.
  // This looks like real strings vibrating past each other.
  // For count=1: use the same default as single-string world.
  const baseYScale = dims.canvasHeight * 0.30;  // 225px at 750px canvas height
  const yScale     = (count > 1) ? Math.min(baseYScale, spacing) : baseYScale;

  // velocityGain: scale proportionally so a click at the same pixel offset
  // from yCenter produces comparable visual amplitude regardless of string count.
  const baseVelocityGain = 20;
  const velocityGain     = baseVelocityGain * (yScale / baseYScale);

  // maxYFraction: fraction of yCenter pixels that the pluck/drag can reach.
  //   Multi-string: 0.30 (constrained so strings don't visually overlap).
  //   Single string: 0.45 (more canvas room, bigger visual swing).
  const maxYFraction = (count > 1) ? 0.30 : 0.45;

  // hitHalfBand: half-height of the y-zone that accepts pointer/strum input.
  //   Multi-string: half a string-spacing gap -- silences clicks in dead zones.
  //   Single string: generous 45% of canvas height (= 0.45 * canvasHeight/2 * 2).
  const hitHalfBand = (count > 1) ? spacing * 0.5 : dims.canvasHeight * 0.45;

  stringSharedGeom = { xLeft, xRight, Lx: xRight - xLeft, yScale, velocityGain,
                       maxYFraction, hitHalfBand };

  // Initialize damping base (applies to all strings).
  // Sync the damping slider to reflect the current dampingBase.
  // dampingBase is set by the caller (setup or resetToPreset) before calling here,
  // so we just sync the UI without changing the value.
  const sl = document.getElementById('slider-zeta');
  const vl = document.getElementById('val-zeta');
  if (sl) sl.value = dampingBase;
  if (vl) vl.textContent = dampingBase.toFixed(3);

  // Build the strings[] array.
  strings = [];
  for (let i = 0; i < count; i++) {
    const bundle = preset.stringBundles[i];

    // Vertical center for this string.
    // i=0 = bottom (lowest pitch), i=count-1 = top (highest pitch).
    // groupBottom is the y of the lowest string; higher strings step up by spacing.
    const yCenter = (count > 1)
      ? groupBottom - i * spacing
      : dims.canvasHeight / 2;

    // Color: interpolated from purple (i=0) to green (i=count-1).
    const color = _stringColor(i, count);

    // Apply default damping to the def before building the modal state.
    bundle.def.setDamping(dampingBase);

    // Create a fresh ModalState and load the preset initial conditions.
    const state = new ModalState(bundle.def);
    state.setPhysicalState(bundle.initialX, bundle.initialV);

    strings.push({
      def:      bundle.def,
      state:    state,
      sound:    null,     // filled below after the full strings[] is assembled
      yCenter:   yCenter,
      color:     color,
      cooldown:  0,       // strum cooldown timestamp (ms); Step 3
      isSplit:   false,   // true when a fixed node divides this string in two; Step 4
      fixedNode: null     // { x0, splitIdx, leftDef, leftState, rightDef, rightState }; Step 4
    });
  }

  // Create one StringSoundObserver per string.
  // gainMult = 1 / sqrt(count): scale each voice down so N simultaneous voices
  // have the same total level as a single voice. 9 strings -> gain 0.6/3 = 0.2.
  const gainMult = 1 / Math.sqrt(count);
  for (let i = 0; i < count; i++) {
    const def   = strings[i].def;
    // Physics fundamental (Hz) from the eigenpair of this string's def.
    // The KS loop pitch = f1_phys * AUDIO_SCALE so it plays at audible pitch.
    const f1_phys = def.omega.length > 0 ? def.omega[0] / (2 * Math.PI) : 2.94;
    const sound   = new StringSoundObserver(dims, def, { gainMult });
    // Override the default A3 (220 Hz) placeholder with this string's actual pitch
    // so ensureAudioGraph() sets the correct KS delay time on first build.
    sound.fundamentalHz = f1_phys * sound.AUDIO_SCALE;
    strings[i].sound = sound;
  }

  // Create a StringVisualObserver that will be used with drawMulti().
  // The constructor's screenGeom is a placeholder; drawMulti() overrides
  // it per-string each frame.
  visualObserver = new StringVisualObserver(dims, strings[0].def, {
    xLeft, xRight, Lx: xRight - xLeft,
    yCenter: dims.canvasHeight / 2,   // placeholder (overridden by drawMulti)
    yScale,
    velocityGain
  });

  // soundObserver is null for multi-string world: each string has its own
  // observer in strings[i].sound. The shared soundObserver global is unused.
  soundObserver = null;

  // Interaction controller in multi-string mode.
  interaction = new StringInteractionController({ strings, sharedGeom: stringSharedGeom });
  window.interaction = interaction;

  // Multi-string (2+) defaults to strum so the user can immediately sweep
  // across strings without having to switch tools manually.
  if (count >= 2) {
    interaction.setTool('strum');
  }
}

function draw() {
  const dt = isFrozen ? 0 : baseDt * timeScale;
  
  // Accumulate forcing time (even when nothing is forced — it's just a clock)
  forcingTime += dt;
  
  background(dims.bgColor);
  /*debug
  stroke(0);
  strokeWeight(1);
  line(0,height/2,width,height/2 );
  */
  // Apply hold and kinematic forcing tools, then advance physics.
  // For 'strings' world: updateMulti() and per-string stepping happen inside
  // the world-specific block below; skip the shared update/step here.
  // For 'mdof' and 'string': interaction.update() returns true when it is
  // kinematically writing the physics state itself (e.g. pluck drag). In that
  // case skip the integrator so accumulated velocities don't fight the shape.
  if (world !== 'strings') {
    const suppressStep = interaction.update(modalState, forcingTime, dt);
    if (!suppressStep) {
      modalState.step(dt);
    }
  }

  // ---- World-specific rendering and sound ----
  if (world === 'mdof') {
    // Auto-correct modal forcing target after any topology change. O(1) per frame.
    if (modalForcingActive) {
      const vo = massLayout.visualOrder;
      const rightmost = vo[vo.length - 1];
      if (rightmost !== modalForcingIdx) {
        modalForcingIdx = rightmost;
        _applyModalForcing();
      }
    }

    // Draw physics state
    const holdState    = interaction.getHoldState();
    const forcingState = interaction.getForcingState();
    // modalForcingIdx is -1 when forcing is off; MassVisualObserver ignores negative values.
    const groundHoverIdx = interaction.getGroundSpringHoverIdx();
    visualObserver.draw(modalState, mdof, holdState, forcingState, modalForcingIdx, groundHoverIdx);

    // Draw hover previews (pointer tool only, drawn above physics layer)
    const couplingHoverPair = interaction.getCouplingHoverPair();
    visualObserver.drawCouplingHoverIndicator(couplingHoverPair, mdof);
    const addMassHoverSide = interaction.getAddMassHoverSide();
    visualObserver.drawAddMassHover(addMassHoverSide);

    // Sound -- pass fixed-mass Map so held masses are muted
    soundObserver.currentFixedMasses = holdState;
    soundObserver.update(modalState, dt, mdof);

    // Panel sync
    if (window.syncModalAnalysisCheckbox) syncModalAnalysisCheckbox();

    // Export state snapshot for the PHYSICS panel to poll each frame
    const couplings = {};
    for (let i = 0; i < mdof.size(); i++) {
      for (let j = i + 1; j < mdof.size(); j++) {
        if (mdof.hasCoupling(i, j)) couplings[i + '-' + j] = mdof.stiffness[i][j];
      }
    }
    // absorberResonanceHz: standalone resonance of the absorber mass.
    // sqrt(k_coupling / m_absorber) / (2*pi). Shown as reference in absorber scenario.
    let absorberResonanceHz = null;
    if (window.activeScene === 'absorber' && mdof.size() >= 2) {
      const kCoup = mdof.stiffness[0][1];
      const mAbs  = mdof.masses[1];
      if (kCoup > 0 && mAbs > 0) absorberResonanceHz = Math.sqrt(kCoup / mAbs) / (2 * Math.PI);
    }
    window.VP_STATE = {
      world:        'mdof',
      nMasses:      mdof.size(),
      nFree:        mdof.omega.length,
      forcingTime:  forcingTime,
      masses:       [...mdof.masses],
      kGround:      [...mdof.kGround],
      couplings:    couplings,
      zeta:         [...mdof.zeta],
      freqs:        mdof.omega.map(w => w / (2 * Math.PI)),
      currentTool:  interaction.getTool(),
      isMuted:             isMuted,
      isFrozen:            isFrozen,
      timeScale:           timeScale,
      modalForcingActive:  modalForcingActive,
      modalForcingHz:      modalForcingOmega / (2 * Math.PI),
      modalForcingAmp:     MODAL_FORCE_AMP,
      modalForcingIdx:     modalForcingIdx,
      dampingSlope:        dampingSlope,
      kinematicForced: Object.fromEntries(
        [...interaction.tools.kinematic.forcedMasses].map(([i, p]) => [i, p.omega / (2 * Math.PI)])
      ),
      visualOrder:  [...massLayout.visualOrder],
      nLeft:        massLayout._nLeft,
      nRight:       massLayout.visualOrder.length - massLayout._nLeft,
      maxPerSide:   dims.maxPerSide,
      fixedMasses:  [...(mdof.fixedMasses || [])],
      absorberResonanceHz: absorberResonanceHz,
      // Helper mode fields.
      lastAction:   _lastAction,
      lastScenario: window.activeScene || null
    };
    _lastAction = null;

  } else if (world === 'string') {
    // Draw string polyline, equilibrium line, and endpoint indicators.
    // getDrawState() returns { mode: 'whole' } normally, or { mode: 'split', ... }
    // when the hold tool has created a fixed node splitting the string.
    const drawState = interaction.getDrawState ? interaction.getDrawState() : { mode: 'whole' };
    // Sync Fourier overlay flags from the Physics panel checkbox + slider.
    // syncFourierControls() also grays the UI when the hold tool is active
    // and updates VP_OVERLAYS (including split suppression) before we read it.
    if (window.syncFourierControls) window.syncFourierControls();
    const ovl = window.VP_OVERLAYS || {};
    visualObserver.showFourierSeries = !!ovl.fourier;
    visualObserver.nFourierModes     = ovl.fourierModes || 16;
    // Mirror N to the KS synth so the audible harmonic count tracks the slider.
    // setNModes() is a no-op when N hasn't changed, so calling every frame is safe.
    if (soundObserver) soundObserver.setNModes(visualObserver.nFourierModes);
    visualObserver.draw(modalState, stringDef, drawState);
    // Update sound observer each frame (no-op until Step 7 adds energy tracking)
    if (soundObserver) soundObserver.update(modalState, dt, stringDef);

    // Write a minimal VP_STATE for string world so the poll() loop can
    // update the shared controls: mute, freeze, speed, damping slider, tool.
    // MDOF-specific fields (masses, kGround, couplings, visualOrder) are
    // given safe empty values; those panel sections are hidden in string world.
    window.VP_STATE = {
      world:        'string',
      // Shared controls
      zeta:        stringDef.zeta.length > 0 ? [stringDef.zeta[0]] : [dampingBase],
      dampingSlope: dampingSlope,
      currentTool:  interaction.getTool(),
      isMuted:      isMuted,
      isFrozen:     isFrozen,
      timeScale:    timeScale,
      // MDOF-specific: empty/safe so poll code doesn't crash
      nMasses:      0,
      nFree:        0,
      masses:       [],
      kGround:      [],
      couplings:    {},
      visualOrder:  [],
      nLeft:        0,
      nRight:       0,
      maxPerSide:   0,
      fixedMasses:  [],
      kinematicForced: {},
      // Modal forcing: not used in string world
      modalForcingActive: false,
      modalForcingHz:     undefined,
      modalForcingAmp:    undefined,
      // Helper mode fields.
      lastAction:   _lastAction,
      lastScenario: null
    };
    _lastAction = null;

  } else if (world === 'strings') {
    // ---- Multi-string world draw ----
    //
    // interaction.updateMulti() returns a Set of string indices to suppress.
    // Suppressed strings are either: (a) being pluck-dragged (shape written by
    // pointerMove), or (b) split into sub-strings (sub-states stepped inside
    // updateMulti itself; main state must not overwrite them).
    const suppressSet = interaction.updateMulti(forcingTime, dt);
    for (let i = 0; i < strings.length; i++) {
      if (!suppressSet.has(i)) {
        strings[i].state.step(dt);
      }
    }

    // Sync Fourier overlay flags. Overlay is suppressed when count > 1
    // (would be too cluttered with 9 strings; deferred to Step 6).
    if (window.syncFourierControls) window.syncFourierControls();
    const ovl = window.VP_OVERLAYS || {};
    visualObserver.showFourierSeries = !!ovl.fourier && strings.length === 1;
    visualObserver.nFourierModes     = ovl.fourierModes || 16;

    // Mirror the mode-count slider to all KS synths so harmonic content
    // tracks the visual partial sum. setNModes() is a no-op when N is unchanged.
    for (let i = 0; i < strings.length; i++) {
      if (strings[i].sound) strings[i].sound.setNModes(visualObserver.nFourierModes);
    }

    // Per-frame sound update (placeholder for Step 7 energy-driven gain modulation).
    for (let i = 0; i < strings.length; i++) {
      if (strings[i].sound) strings[i].sound.update(strings[i].state, dt, strings[i].def);
    }

    // Draw all strings. getMultiDrawStates() returns one drawState per string:
    // { mode:'whole' } or { mode:'split', nodeKsi, leftState/Def, rightState/Def }.
    const multiDrawStates = interaction.getMultiDrawStates();
    visualObserver.drawMulti(strings, stringSharedGeom, multiDrawStates);

    // Modal energy overlay: right-side bar chart, single string only.
    // Suppressed for multi-string (too cluttered; energies are per-string not per-mode).
    if (ovl.modalEnergy && strings.length === 1) {
      visualObserver.drawModalEnergyOverlay(strings[0].state, strings[0].def, 16);
    }

    // Minimal VP_STATE for shared panel controls.
    window.VP_STATE = {
      world:       'strings',
      stringCount:  strings.length,   // used by Menu.js to show strum only for multi-string
      // stringFreqs: first 16 modal frequencies of the (single) string in Hz.
      // Used by Menu.js to populate mode-shape button titles in the flyout.
      // Empty array when multi-string (mode buttons are disabled for multi).
      stringFreqs: strings.length === 1
        ? strings[0].def.omega.slice(0, 16).map(w => w / (2 * Math.PI))
        : [],
      // Current tension of the (single) string in Newtons.
      // Used by Menu.js to keep the tension slider readout in sync
      // while the user drags an endpoint to change tension live.
      // Undefined for multi-string.
      stringTension: strings.length === 1 ? strings[0].def.tension : undefined,
      zeta:        strings.length > 0 && strings[0].def.zeta.length > 0
                   ? [strings[0].def.zeta[0]] : [dampingBase],
      dampingSlope: dampingSlope,
      currentTool:  interaction.getTool(),
      isMuted:      isMuted,
      isFrozen:     isFrozen,
      timeScale:    timeScale,
      nMasses: 0, nFree: 0, masses: [], kGround: [], couplings: {},
      visualOrder: [], nLeft: 0, nRight: 0, maxPerSide: 0, fixedMasses: [],
      kinematicForced: {},
      modalForcingActive: false, modalForcingHz: undefined, modalForcingAmp: undefined,
      // Helper mode fields.
      lastAction:   _lastAction,
      lastScenario: null
    };
    _lastAction = null;
  }

  // ---- Shared: custom cursor drawn on top for all worlds ----
  visualObserver.drawCursor(interaction.getTool(), mouseX, mouseY);
}
function toggleMute() {
  if (!window.Tone) return;

  // On iOS, ensure context is started before toggling mute
  // (in case user clicks mute button before any other interaction)
  Tone.start().then(() => {
    isMuted = !isMuted;
    Tone.Destination.mute = isMuted;
  });
}

function resetToPreset() {
  // Reload the stored preset (read from window to pick up external updates)
  const presetSource = window.storedPresetJSON || storedPresetJSON;
  const preset = PresetLoader.load(presetSource);

  // Update stored preset for future resets
  storedPresetJSON = presetSource;
  window.storedPresetJSON = presetSource;

  // Settings shared by all worlds
  isMuted   = preset.soundMuted;
  timeScale = preset.timeScale;
  isFrozen  = preset.timeFrozen;
  if (window.Tone) Tone.Destination.mute = isMuted;
  forcingTime = 0;

  // Track previous world so we know whether objects need full recreation
  const prevWorld = world;
  world = preset.world;

  if (world === 'mdof') {
    // Clear modal forcing state before rebuild (stale force vector must not persist)
    if (modalForcingActive) {
      modalForcingActive = false;
      modalForcingIdx    = -1;
      modalForcingOmega  = MODAL_FORCE_OMEGA_DEFAULT;
      modalState.clearForcing();
    }

    mdof = preset.definition;
    modalState.rebuild(mdof);
    modalState.setPhysicalState(preset.initialX, preset.initialV);

    // Guard: massLayout may not exist if setup() ran in string world.
    if (!massLayout) massLayout = new MassLayout(dims);
    massLayout.rebuild(mdof);
    window.massLayout = massLayout;

    if (prevWorld === 'string') {
      // Switching from string world: must recreate MDOF-specific objects because
      // interaction was a StringInteractionController (no .tools.kinematic etc.)
      // and visualObserver was a StringVisualObserver.
      visualObserver = new MassVisualObserver(dims);
      soundObserver  = new MassSoundObserver(dims);
      window.soundObserver = soundObserver;
      interaction = new MassInteractionController({
        ...dims,
        mdof: mdof,
        modalState: modalState,
        soundObserver: soundObserver,
        defaultK: 50,
      });
      window.interaction = interaction;
    } else {
      // Staying in MDOF world: patch existing controller in place.
      // This preserves Tone.js audio nodes and avoids any audio teardown artifacts.
      interaction.mdof       = mdof;
      interaction.modalState = modalState;
      interaction.tools.kinematic.clearAll();
      interaction.tools.kinematic.setForcingTarget(-1);
      interaction.tools.hold.releaseAll();
      mdof.fixedMasses.clear();
    }

  } else if (world === 'string') {
    // Rebuild string definition and physics state
    stringDef = preset.definition;

    // When entering string world from MDOF, reset dampingBase to the string
    // default (0.1) and sync the slider. This prevents the lower MDOF damping
    // value from being applied to the string on first entry.
    // Staying in string world: use dampingBase as-is (the user's slider setting).
    if (prevWorld !== 'string') {
      dampingBase = 0.1;
      const sl = document.getElementById('slider-zeta');
      const vl = document.getElementById('val-zeta');
      if (sl) sl.value  = 0.1;
      if (vl) vl.textContent = '0.100';
    }
    stringDef.setDamping(dampingBase);
    modalState.rebuild(stringDef);
    modalState.setPhysicalState(preset.initialX, preset.initialV);

    // Recompute screen geometry -- same formula as setup() so endpoints always
    // align with the outermost MDOF arc equilibrium positions.
    const maxK   = dims.maxPerSide - 1;
    const midX   = dims.canvasWidth / 2;
    const xLeft  = midX - (maxK + 0.5) * dims.radiusGap;
    const xRight = midX + (maxK + 0.5) * dims.radiusGap;
    stringScreenGeom = {
      xLeft,
      xRight,
      Lx:          xRight - xLeft,
      yCenter:     dims.canvasHeight / 2,
      yScale:      dims.canvasHeight * 0.60,
      velocityGain: 40
    };

    visualObserver = new StringVisualObserver(dims, stringDef, stringScreenGeom);
    // Dispose previous StringSoundObserver (if any) before replacing it,
    // so orphaned Tone.js nodes don't accumulate across resets.
    if (soundObserver && typeof soundObserver.dispose === 'function') {
      soundObserver.dispose();
    }
    soundObserver  = new StringSoundObserver(dims, stringDef);
    interaction    = new StringInteractionController({
      stringDef, modalState,
      soundObserver,
      screenGeom: stringScreenGeom
    });
    window.interaction = interaction;

  } else if (world === 'strings') {
    // Dispose all per-string sound observers from the previous setup before
    // recreating them. soundObserver (the single-string shared one) is null
    // in multi-string mode, so skip that check and loop over strings[] instead.
    for (const s of strings) {
      if (s.sound && typeof s.sound.dispose === 'function') s.sound.dispose();
    }
    // Rebuild strings[], shared geom, visual and interaction objects.
    // _initMultiStrings() handles the dampingBase reset (if prevWorld !== 'strings')
    // by resetting dampingBase and syncing the slider inside itself.
    if (prevWorld !== 'strings') {
      // Force dampingBase reset when entering from another world.
      // _initMultiStrings reads dampingBase; write it before calling.
      dampingBase = 0.1;
    }
    _initMultiStrings(preset);
  }
}
// _isCanvasEvent(event) -- returns true only when the p5 mouse event
// originated directly on the canvas element.  HTML overlay elements
// (menu tabs, panel buttons) positioned over the canvas have a different
// event.target, so this guard prevents ground-spring edge clicks from
// firing when the user clicks a UI tab near the canvas boundary.
function _isCanvasEvent(event) {
  if (!event) return true;            // no event object: allow (keyboard-driven)
  const t = event.target;
  return t && t.tagName === 'CANVAS';
}

function mousePressed(event) {
  // Ignore clicks outside canvas bounds.
  if (mouseX < 0 || mouseX > width || mouseY < 0 || mouseY > height) return;
  // Ignore clicks on HTML overlay elements (menu tabs etc.) that sit over canvas.
  if (!_isCanvasEvent(event)) return;
  interaction.pointerDown(mouseX, mouseY);
}
// mouseMoved fires when the mouse moves with NO button held (hover).
// Required for coupling hover indicator -- mouseDragged fires only during drag.
function mouseMoved(event) {
  if (mouseX < 0 || mouseX > width || mouseY < 0 || mouseY > height) {
    // Mouse has left the canvas -- clear all hover indicators immediately
    // so they don't persist while the user interacts with UI outside the canvas.
    interaction.clearHover();
    return;
  }
  if (!_isCanvasEvent(event)) {
    interaction.clearHover();
    return;
  }
  interaction.pointerMove(mouseX, mouseY);
}
function mouseDragged(event) {
  if (mouseX < 0 || mouseX > width || mouseY < 0 || mouseY > height) return;
  if (!_isCanvasEvent(event)) return;
  _dragOccurred = true;
  interaction.pointerMove(mouseX, mouseY);
}
function mouseReleased() {
  // Classify the completed interaction for HelperMode.js before handing off.
  // Coupling fires on pointerDown (not drag/release), so check _lastPointerAction
  // first; it overrides the drag/strike classification for that case.
  if (interaction && interaction._lastPointerAction) {
    _lastAction = interaction._lastPointerAction;
    interaction._lastPointerAction = null;
  } else {
    _lastAction = _dragOccurred ? 'drag' : 'strike';
  }
  _dragOccurred = false;
  interaction.pointerUp(mouseX, mouseY);
}
// _touchOnCanvas -- true when the current touch sequence started inside the canvas.
// touchMoved and touchEnded only process (and block) the event when this is true,
// so taps on menu buttons, tabs, and other page elements outside the canvas
// propagate normally to the DOM instead of being swallowed by p5.js.
let _touchOnCanvas = false;

function touchStarted() {
  _touchOnCanvas = (mouseX >= 0 && mouseX <= width && mouseY >= 0 && mouseY <= height);
  if (!_touchOnCanvas) return;  // outside canvas -- let event reach menu/buttons
  interaction.pointerDown(mouseX, mouseY);
  return false;  // inside canvas -- prevent scroll/zoom and stop propagation
}
function touchMoved() {
  if (!_touchOnCanvas) return;  // touch started outside canvas -- don't interfere
  interaction.pointerMove(mouseX, mouseY);
  return false;
}
function touchEnded() {
  if (!_touchOnCanvas) return;  // touch started outside canvas -- don't interfere
  _touchOnCanvas = false;
  interaction.pointerUp(mouseX, mouseY);
  return false;
}

// _applyModalForcing()
// (Re-)builds the force vector for the current modalForcingIdx and calls
// modalState.setForcing(). Also notifies KinematicTool which mass to skip.
// Must be called whenever forcing is activated, or whenever omega or the
// target mass index changes while forcing is active.
function _applyModalForcing() {
  const fVec = new Array(mdof.size()).fill(0);
  fVec[modalForcingIdx] = MODAL_FORCE_AMP;
  modalState.setForcing(fVec, modalForcingOmega);
  // KinematicTool skips this mass so kinematic drag cannot grab a modally-forced mass.
  interaction.tools.kinematic.setForcingTarget(modalForcingIdx);
}

// _toggleModalForcing
// 'f' key: toggle applied-force modal forcing on the outermost right mass.
// When active, ModalState drives f(t) = AMP*sin(omega*t) on modalForcingIdx.
// The mass remains dynamically free; KinematicTool only is prevented from
// grabbing it (HoldTool can still perturb it).
// Frequency nudgeable with UP/DOWN arrows.
function _toggleModalForcing() {
  if (modalForcingActive) {
    modalForcingActive = false;
    modalForcingIdx    = -1;
    modalState.clearForcing();
    interaction.tools.kinematic.setForcingTarget(-1);
    // Turning forcing off while in the absorber scenario clears the absorber
    // resonance label -- it is only meaningful while forcing is active.
    if (window.activeScene === 'absorber') window.activeScene = null;
  } else {
    // Target: outermost right mass = last entry in visualOrder.
    const vo = massLayout.visualOrder;
    modalForcingIdx    = vo[vo.length - 1];
    modalForcingActive = true;

    // Ensure the forced mass has a ground spring -- without one it has no
    // restoring force and won't resonate at a well-defined frequency.
    if (mdof.kGround[modalForcingIdx] === 0) {
      mdof.kGround[modalForcingIdx] = MassInteractionController.DEFAULT_K_GROUND;
      mdof.recompute();
      modalState.rebuild(mdof);
    }

    _applyModalForcing();
  }
}

function keyPressed() {
  // Freeze / unfreeze physics time.
  if (key === 'q' || key === 'Q') {
    window.vpToggleFreeze();
    return;
  }

  // Tool selection keys
  if (key === 'v' || key === 'V') {
    interaction.setTool('pointer');
  }
  else if (key === 'h' || key === 'H') {
    interaction.setTool('hold');
  }
  else if (key === 's' || key === 'S') {
    // Strum tool: only meaningful in multi-string world.
    // Sweeping the mouse vertically triggers each string as the mouse crosses it.
    if (world === 'strings') {
      interaction.setTool('strum');
    }
  }
  else if (key === '-' || key === '_') {
    interaction.setTool('delete');
  }
  else if (key === 'k' || key === 'K') {
    // 'k' - kinematic excitation tool (prescribed displacement)
    interaction.setTool('kinematic');
  }
  else if (key === 'f' || key === 'F') {
    // 'f' - toggle prescribed-displacement forcing on mass 0.
    // Call vpToggleModalForcing (not _toggleModalForcing) so the mutual-exclusion
    // logic (clear kinematic, switch to pointer tool) also runs from the keyboard.
    if (window.vpToggleModalForcing) vpToggleModalForcing();
  }
  
  // Release all forced and fixed masses -- works regardless of active tool.
  // This is the "let go and observe" gesture.
  else if (key === 'r' || key === 'R') {
    interaction.tools.kinematic.clearAll();
    // Release any fixed masses (HoldTool click-to-fix).
    const holdTool = interaction.tools.hold;
    if (holdTool.fixedMasses.size > 0) {
      for (const gi of holdTool.fixedMasses.keys()) {
        mdof.releaseMass(gi);
      }
      holdTool.releaseAll();
      modalState.rebuild(mdof);
    }
  }
  
  // Mass size adjustment (when holding a mass)
  else if (keyCode === LEFT_ARROW) {
    interaction.changeMassSize(-1);  // decrease mass
  }
  else if (keyCode === RIGHT_ARROW) {
    interaction.changeMassSize(1);   // increase mass
  }
  
  // Frequency nudge: context-sensitive.
  //   Modal forcing active ('f' mode): nudge modalForcingOmega by ±0.05 Hz,
  //     then re-call setForcing so the change takes effect immediately.
  //   Otherwise: nudge kinematic tool omega (used when 'k' tool is active).
  // ±0.05 Hz per key = 100 steps across the panel slider's 0.1-5 Hz range.
  else if (keyCode === UP_ARROW) {
    if (modalForcingActive) {
      modalForcingOmega = Math.max(0.01 * 2 * Math.PI,
                                   modalForcingOmega + 0.05 * 2 * Math.PI);
      _applyModalForcing();
    } else {
      interaction.tools.kinematic.nudgeOmega(0.05);
    }
  }
  else if (keyCode === DOWN_ARROW) {
    if (modalForcingActive) {
      modalForcingOmega = Math.max(0.01 * 2 * Math.PI,
                                   modalForcingOmega - 0.05 * 2 * Math.PI);
      _applyModalForcing();
    } else {
      interaction.tools.kinematic.nudgeOmega(-0.05);
    }
  }
}

// ---------------------------------------------------------------------------
// Panel-callable functions
//
// These are set on window so the panel HTML can call them without importing
// or depending on any sketch internals. All physics mutations go through here.
// ---------------------------------------------------------------------------

window.vpSetTool = function(toolName) {
  interaction.setTool(toolName);
};

window.vpToggleMute = function() {
  toggleMute();
};

window.vpReset = function() {
  resetToPreset();
};

// vpZeroState -- set all displacements and velocities to zero (equilibrium).
// Physics topology (masses, stiffness, damping) is unchanged.
// Uses Nspatial (freeToGlobal.length) to build the zero arrays; this equals
// N for MDOF and Nx (interior spatial points) for string world.
window.vpZeroState = function() {
  if (world === 'strings') {
    // Multi-string: zero each string's state independently.
    for (const s of strings) {
      const zeros = new Array(s.def.freeToGlobal.length).fill(0);
      s.state.setPhysicalState(zeros, zeros);
    }
    return;
  }
  const def    = (world === 'string') ? stringDef : mdof;
  const Nspatial = def.freeToGlobal.length;
  const zeros    = new Array(Nspatial).fill(0);
  modalState.setPhysicalState(zeros, zeros);
};

// vpAddMass(side)
//   Adds a mass at the outermost position on the given side.
//   Delegates to interaction.addMass(side) which handles property inheritance:
//   ground spring, coupling, and free-mass zero-displacement rules.
//   If modal forcing is active, clears it before the add (rebuild inside
//   addMass() would choke on the stale force vector) then re-applies after.
window.vpAddMass = function(side) {
  // Topology change exits any active scenario (clears absorber resonance display, etc.)
  window.activeScene = null;

  // Clear forcing before the internal rebuild inside interaction.addMass().
  if (modalForcingActive) modalState.clearForcing();

  const newIdx = interaction.addMass(side);
  if (newIdx !== -1) {
    // Re-apply frequency-dependent damping so the new mode gets the correct zeta.
    _applyDamping();

    if (modalForcingActive && side === 'right') {
      // Forcing target advances to the new outermost right mass.
      const vo = massLayout.visualOrder;
      modalForcingIdx = vo[vo.length - 1];
      _applyModalForcing();
    } else if (modalForcingActive) {
      // Left-side add: target unchanged, but N grew so rebuild the force vector.
      _applyModalForcing();
    }
  }
};

// vpRemoveMass(side)
//   Removes the outermost visual mass on the given side ('left' or 'right').
//   Delegates to interaction.removeMassAtSide() which handles the swap-then-pop
//   logic needed when the outermost visual mass is not the last physics index.
//   removeMassAtSide() calls modalState.rebuild() internally, which tries to
//   re-use the stale forcingVector (wrong length). If forcing is active on the
//   right, we re-apply it with the new rightmost target afterwards.
window.vpRemoveMass = function(side) {
  // Topology change exits any active scenario (clears absorber resonance display, etc.)
  window.activeScene = null;

  // removeMassAtSide() calls modalState.rebuild() internally.
  // Clear forcing before that rebuild so rebuild() does not try to recompute
  // modal forces with the old-length force vector. Re-apply after.
  if (modalForcingActive) modalState.clearForcing();

  interaction.removeMassAtSide(side || 'right');

  // Re-apply frequency-dependent damping after topology change.
  _applyDamping();

  if (modalForcingActive) {
    const vo = massLayout.visualOrder;
    if (vo.length > 0) {
      if (side === 'right' || !side) {
        // Forcing target moves to the new outermost right mass.
        modalForcingIdx = vo[vo.length - 1];
      }
      // Left-side remove: target index is unchanged (it was on the right).
      _applyModalForcing();
    } else {
      // Safety net -- should never happen since N >= 1 is enforced.
      modalForcingActive = false;
      modalForcingIdx    = -1;
      interaction.tools.kinematic.setForcingTarget(-1);
    }
  }
};

window.vpToggleFreeze = function() {
  isFrozen = !isFrozen;
};

// Damping state for frequency-dependent damping.
// dampingBase:  uniform damping ratio set by the main damping slider.
// dampingSlope: per-mode increment. zeta_n = dampingBase + dampingSlope * (n / (N-1)).
//   n = 0 is the lowest mode; n = N-1 is the highest mode.
//   At slope = 0: all modes get dampingBase (uniform).
//   At slope = 0.5: highest mode gets dampingBase + 0.5 more than mode 0.
// 0.05 matches the default slider value in index.html.
let dampingBase  = 0.05;
let dampingSlope = 0;

// _applyDamping()
//   Writes per-mode zeta values into mdof.zeta.
//   ModalState reads mdof.zeta directly each step, so no rebuild needed.
//   Clamped to [0, 2] -- overdamped limit is zeta = 1; 2 is a safe ceiling.
//   Guard: mdof may be undefined when starting in string world.
function _applyDamping() {
  if (!mdof || !mdof.zeta) return;
  const N = mdof.zeta.length;
  for (let n = 0; n < N; n++) {
    const frac = N > 1 ? n / (N - 1) : 0;  // 0 for mode 0, 1 for highest mode
    mdof.zeta[n] = Math.max(0, Math.min(2, dampingBase + dampingSlope * frac));
  }
}

// vpSetDamping(value)
//   Sets the uniform base damping ratio. Re-applies with current slope.
//   For MDOF world: writes per-mode zeta into mdof.zeta (read each step).
//   For string world: calls stringDef.setDamping() which rewrites zeta in place.
//   No rebuild needed in either world.
window.vpSetDamping = function(value) {
  dampingBase = Math.max(0, value);
  _applyDamping();
  // Single-string world: apply to stringDef.zeta and KS synth.
  if (world === 'string' && typeof stringDef !== 'undefined' && stringDef) {
    stringDef.setDamping(dampingBase);
    if (soundObserver && soundObserver.setDamping) {
      soundObserver.setDamping(dampingBase);
    }
  }
  // Multi-string world: apply to all strings' defs and KS synths.
  if (world === 'strings') {
    for (const s of strings) {
      s.def.setDamping(dampingBase);
      if (s.sound && s.sound.setDamping) s.sound.setDamping(dampingBase);
    }
  }
};

// vpSetDampingSlope(slope)
//   Sets the per-mode damping slope (additional zeta per fractional mode index).
//   Highest mode gets dampingBase + slope; lowest mode stays at dampingBase.
//   For MDOF world: writes per-mode zeta via _applyDamping().
//   For string world: calls soundObserver.setDampingSlope() to update the
//   in-loop KS filter cutoff, which controls frequency-dependent ring-down.
window.vpSetDampingSlope = function(slope) {
  dampingSlope = Math.max(0, slope);
  _applyDamping();
  if (world === 'string' && soundObserver && soundObserver.setDampingSlope) {
    soundObserver.setDampingSlope(dampingSlope);
  }
  if (world === 'strings') {
    for (const s of strings) {
      if (s.sound && s.sound.setDampingSlope) s.sound.setDampingSlope(dampingSlope);
    }
  }
};

window.vpSetMass = function(physicsIndex, value) {
  if (physicsIndex < 0 || physicsIndex >= mdof.size()) return;
  mdof.masses[physicsIndex] = value;
  mdof.recompute();
  modalState.rebuild(mdof);
};

window.vpSetKGround = function(physicsIndex, value) {
  if (physicsIndex < 0 || physicsIndex >= mdof.size()) return;
  mdof.kGround[physicsIndex] = value;
  mdof.recompute();
  modalState.rebuild(mdof);
  // Any ground-spring change while in the absorber scenario invalidates the
  // absorber resonance label (the displayed tuning assumes the original kGround).
  if (window.activeScene === 'absorber') window.activeScene = null;
};

// vpCoupleAll(k)
//   Adds coupling springs (stiffness k) between every visually adjacent mass pair.
//   Adjacency is defined by massLayout.visualOrder, same as the CouplingTool.
//   Default k=50 matches the CouplingTool defaultK.
window.vpCoupleAll = function(k) {
  const vo  = massLayout.visualOrder;
  const kV  = (k !== undefined) ? k : 50;
  for (let vi = 0; vi < vo.length - 1; vi++) {
    mdof.setCoupling(vo[vi], vo[vi + 1], kV);
  }
  mdof.recompute();
  modalState.rebuild(mdof);
};

// vpUncoupleAll()
//   Removes coupling between ALL mass pairs (not just visually adjacent).
//   Iterates the full stiffness matrix so nothing is missed.
window.vpUncoupleAll = function() {
  const N = mdof.size();
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (mdof.hasCoupling(i, j)) {
        mdof.setCoupling(i, j, 0);
      }
    }
  }
  mdof.recompute();
  modalState.rebuild(mdof);
};

// vpGroundAll(k)
//   Sets kGround[i] = k for every mass. Default k=10 (same as base scenarios).
window.vpGroundAll = function(k) {
  const kV = (k !== undefined) ? k : 10;
  for (let i = 0; i < mdof.size(); i++) {
    mdof.kGround[i] = kV;
  }
  mdof.recompute();
  modalState.rebuild(mdof);
};

// vpUngroundAll()
//   Sets kGround[i] = 0 for every mass (free-floating -- no ground spring).
//   Exception: when modal forcing is active, the forced mass keeps its
//   current kGround value. A free-floating forced mass would have no
//   equilibrium to oscillate around and would drift; the ground spring
//   keeps it tethered so the forcing makes physical sense.
window.vpUngroundAll = function() {
  for (let i = 0; i < mdof.size(); i++) {
    if (modalForcingActive && i === modalForcingIdx) continue;  // immune
    mdof.kGround[i] = 0;
  }
  mdof.recompute();
  modalState.rebuild(mdof);
};

// vpToggleModalForcing()
//   Toggle applied-force modal forcing ('f' key and panel button).
//   Mutual exclusion: activating modal forcing clears kinematic forcing
//   and switches to pointer tool, per the UI contract in CLAUDE.md.
window.vpToggleModalForcing = function() {
  _toggleModalForcing();
  // After toggle, modalForcingActive reflects the NEW state.
  if (modalForcingActive) {
    // Clear kinematic forcing -- a kinematically-driven mass conflicts with a
    // modally-forced one. Switch to pointer so the user can observe the response.
    interaction.tools.kinematic.clearAll();
    interaction.setTool('pointer');
  }
};

// vpSetModalForcingHz(hz)
//   Changes the forcing frequency. If active, re-calls setForcing() immediately.
//   ModalState.setForcing() preserves forcingTime (no phase reset), so omega
//   changes mid-run are phase-continuous -- no displacement jump.
window.vpSetModalForcingHz = function(hz) {
  modalForcingOmega = Math.max(0.01, hz) * 2 * Math.PI;
  if (modalForcingActive) {
    _applyModalForcing();
  }
};

// vpLaunchModeShape(n)
//   Sets physical state to mode shape n (0-based index).
//   Displacement x[i] = Phi[li][n] * scale for free masses (li = local free index);
//   fixed masses keep displacement 0.  Velocities are set to 0.
//   Scale normalises so the largest free-mass component has magnitude 0.5.
//   Forcing (modal or kinematic) is NOT cleared -- the mode shape is an
//   initial condition only.  If forcing is active it will immediately drive
//   the system from that starting position.
window.vpLaunchModeShape = function(n) {
  if (!mdof || !mdof.Phi) return;

  // Nfree: number of free (non-fixed) modes.  Phi is Nfree x Nfree.
  const Nfree  = mdof.omega.length;
  const Ntotal = mdof.size();
  if (n < 0 || n >= Nfree) return;

  // Find max absolute component of mode n across all free masses.
  let maxAbs = 0;
  for (let li = 0; li < Nfree; li++) {
    maxAbs = Math.max(maxAbs, Math.abs(mdof.Phi[li][n]));
  }
  if (maxAbs < 1e-10) return;   // degenerate mode, nothing to show

  // Build normalised physical displacement vector (length Ntotal).
  // Free masses: Phi[li][n] * scale, where li = globalToFree.get(globalIdx).
  // Fixed masses: leave at 0 (they are boundary conditions).
  const scale = 0.5 / maxAbs;
  const x = new Array(Ntotal).fill(0);
  for (let gi = 0; gi < Ntotal; gi++) {
    const li = mdof.globalToFree.get(gi);
    if (li !== undefined) {
      x[gi] = mdof.Phi[li][n] * scale;
    }
  }

  // Set initial condition.  Any active forcing continues from this position.
  modalState.setPhysicalState(x, new Array(Ntotal).fill(0));
};

// vpLaunchStringMode(n)
//   Sets the single string (strings world, count=1) to vibrate in pure mode n
//   (0-based index).  Sets the modal displacement q[n] = 1 (normalised so the
//   largest spatial displacement is 0.5 m), all other modal coordinates zero.
//   Also drops damping to its minimum value so the mode rings down slowly.
//   No-op for multi-string world or when n is out of range.
window.vpLaunchStringMode = function(n) {
  if (world !== 'strings' || !strings || strings.length !== 1) return;
  const s   = strings[0];
  const def = s.def;
  const N   = def.omega.length;
  if (n < 0 || n >= N) return;

  // Find the largest absolute component of mode n across spatial points.
  const Nspatial = def.freeToGlobal.length;
  let maxAbs = 0;
  for (let li = 0; li < Nspatial; li++) {
    maxAbs = Math.max(maxAbs, Math.abs(def.Phi[li][n]));
  }
  if (maxAbs < 1e-10) return;   // degenerate mode

  // Scale so max displacement = 0.5 m (matches vpLaunchModeShape convention).
  const scale = 0.5 / maxAbs;
  const x = new Array(Nspatial).fill(0);
  for (let li = 0; li < Nspatial; li++) {
    const gi = def.freeToGlobal[li];
    x[gi]    = def.Phi[li][n] * scale;
  }

  // Set displacement; zero velocity (pure standing wave at max amplitude).
  s.state.setPhysicalState(x, new Array(Nspatial).fill(0));

  // Set damping to a low but audible value.  0.02 gives a ring time of
  // roughly 1 / (2*pi * zeta * omega_1) seconds, which is several seconds
  // for typical f1 values -- long enough to hear the mode clearly.
  if (window.vpSetDamping) window.vpSetDamping(0.02);

  // Trigger Karplus-Strong synthesis so the mode produces sound.
  // Strike position: quarter-point of string (ksi = L/4) -- avoids nodes
  // of low modes and excites the full harmonic series evenly.
  // Velocity: scaled to be a gentle but audible hit (v0 = 5 m/s).
  // Pitch: mode n frequency in Hz from the stringDef.
  const hz  = s.def.omega[n] / (2 * Math.PI);   // mode n frequency (Hz)
  const ksi = s.def.L * 0.25;                   // quarter-point strike position (m)
  s.sound.triggerStrike(ksi, 5, hz);
};

// vpSetStringTension(T)
//   Sets the tension of the single string in Newtons, then recomputes eigenpairs
//   and rebuilds ModalState so the running simulation immediately reflects the
//   new pitch.  No-op for multi-string worlds.
//
//   Called by:
//     - Menu.js slider-string-tension onChange handler (user drags slider)
//
//   The ModalState rebuild preserves approximate modal amplitudes by projecting
//   the current physical displacement into the new modal basis (ModalState.rebuild
//   handles this internally).
//
// @param {number} T -- tension (N), clamped to [10, 400]
window.vpSetStringTension = function(T) {
  if (world !== 'strings' || !strings || strings.length !== 1) return;
  const s   = strings[0];
  const def = s.def;

  // Clamp to physical range [10, 400] N.
  const Tclamped = Math.max(10, Math.min(400, T));

  // Update tension; recompute() internally recalculates c = sqrt(T/mu)
  // and rebuilds omega, Phi, zeta.
  def.tension = Tclamped;
  def.recompute();

  // Rebuild ModalState: projects current physical displacement into the new
  // modal basis so the waveform shape is preserved across the pitch change.
  s.state.rebuild(def);

  // Update the KS synthesizer pitch without triggering a new note.
  // f1 = omega[0] / (2*pi) is the new fundamental.
  const f1 = def.omega.length > 0 ? def.omega[0] / (2 * Math.PI) : undefined;
  if (f1 && s.sound && s.sound.setFundamental) {
    s.sound.setFundamental(f1);
  }
};

// vpSetHammerWidth(w)
//   Sets the hammer contact zone as a fraction of string length.
//   Passed through to StringInteractionController.setHammerWidth(), which
//   clamps to [0.01, 0.50] and writes to strikeTool.hammerWidth.
window.vpSetHammerWidth = function(w) {
  if (world !== 'strings' || !interaction) return;
  interaction.setHammerWidth(w);
};

// vpSetForcingAmp(amp)
//   Changes the peak force amplitude in Newtons. If active, re-applies immediately.
window.vpSetForcingAmp = function(amp) {
  MODAL_FORCE_AMP = Math.max(0.01, amp);
  if (modalForcingActive) {
    _applyModalForcing();
  }
};

// vpSetKinematicPanelForcing(physIdx, active, hz)
//   Programmatically enables or disables kinematic (prescribed-displacement) forcing
//   on mass physIdx from the PHYSICS panel controls, independent of the active tool.
//
//   When active = true:
//     Inserts an entry into KinematicTool.forcedMasses with amplitude=0.5 and
//     omega = hz * 2*pi.  phaseOffset is computed so x(t_now) = 0 (smooth start
//     from equilibrium, no position jump).  KinematicTool.applyKinematic() is
//     called every frame regardless of tool selection, so forcing is immediate.
//   When active = false:
//     Removes the entry from forcedMasses.
//
//   Mutual exclusion: if modal forcing is active and physIdx === modalForcingIdx,
//     the call is silently ignored (modal forcing owns that mass).
window.vpSetKinematicPanelForcing = function(physIdx, active, hz) {
  if (active) {
    // Block if modal forcing owns this physics index.
    if (modalForcingActive && physIdx === modalForcingIdx) return;
    const omega = Math.max(0.01, hz) * 2 * Math.PI;
    // _lastForcingTime is updated every frame by applyKinematic so it is current.
    // phaseOffset = -omega * t ensures sin(omega * t + phaseOffset) = 0 at t=now,
    // giving a smooth start from x = 0 with no displacement jump.
    const t = interaction.tools.kinematic._lastForcingTime;
    const phaseOffset = -omega * t;
    interaction.tools.kinematic.forcedMasses.set(physIdx, {
      amplitude:   0.5,
      omega:       omega,
      phaseOffset: phaseOffset,
      offset:      0
    });
  } else {
    interaction.tools.kinematic.forcedMasses.delete(physIdx);
  }
};

// vpSetTimeScale(value)
//   Sets the simulation speed multiplier. dt = baseDt * timeScale each frame.
//   value: 0.1 (10% speed, slow motion) to 3.0 (3x fast-forward).
//   Clamped to [0.05, 5] to prevent degenerate integration.
window.vpSetTimeScale = function(value) {
  timeScale = Math.max(0.05, Math.min(5, value));
};

window.vpSetCoupling = function(i, j, value) {
  mdof.setCoupling(i, j, value);
  mdof.recompute();
  modalState.rebuild(mdof);
};

// vpSetDetune(cents)
//   Sets the FatOscillator spread for the mass ring voices.
//   spread = cents of detuning between the two internal oscillators in each
//   FatOscillator.  0 = pure sine (no chorus), 50 = wide chorus effect.
//   The new value is stored immediately and applied on the next zero-crossing
//   trigger.  Voices already in their decay are not retroactively updated.
window.vpSetDetune = function(cents) {
  soundObserver.setRingSpread(cents);
};

// vpSetBasePitch(hz)
//   Sets the root pitch of the tonnetz fifths chain (default: A2 = 110 Hz).
//   Right-side masses descend in fifths; left-side masses ascend.
//   Updates all currently running ring oscillators immediately.
window.vpSetBasePitch = function(hz) {
  soundObserver.setBasePitch(hz);
};