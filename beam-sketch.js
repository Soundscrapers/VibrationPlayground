/**
 * beam-sketch.js
 *
 * p5.js sketch running in WEBGL mode on beam.html.
 * Separate page from index.html, lattice.html, and membrane.html.
 *
 * Responsibility:
 *   - Own time (dt) and the physics loop
 *   - Build BeamBendingDefinition, BeamExtensionalDefinition, both ModalStates
 *   - Drive BeamVisualObserver (rendering), BeamInteractionController (input)
 *   - Coordinate keyboard shortcuts and UI panel event handlers
 *
 * Coordinate convention (WEBGL, origin at canvas center, +y is DOWN):
 *   Beam axis along world_x  (left end = -L/2*S, right end = +L/2*S)
 *   Bending along world_y    (+y = positive transverse displacement = downward)
 *   Cross-section depth in z (±halfH world units)
 *
 * Two independent physics systems:
 *   bendingState    -- Euler-Bernoulli bending, dispersive n^2 spectrum
 *   extensionalState -- longitudinal compression, harmonic spectrum
 *
 * The sketch sums both for rendering by passing wBend and uExt to the
 * visual observer. Neither ModalState knows about the other.
 *
 * Scale constants:
 *   BEND_SCALE: world units per meter of transverse bending displacement.
 *               Analogous to Z_SCALE in membrane-sketch.js.
 *   EXT_SCALE:  world units per meter of axial extensional displacement.
 *   _beamScale(): dynamic -- world units per meter of beam length.
 *                 Keeps beam filling the canvas as L changes via slider.
 */

// --- Physics globals ---
let bendingDef;          // BeamBendingDefinition: y-plane bending (depth axis, I)
let bendingDefZ;         // BeamBendingDefinition: z-plane bending (width axis, I_lateral)
let extensionalDef;      // BeamExtensionalDefinition: cos modes, harmonic spectrum
let bendingState;        // ModalState: y-bending modal coordinates q, qdot
let bendingStateZ;       // ModalState: z-bending modal coordinates q, qdot
let extensionalState;    // ModalState: extensional modal coordinates
let currentCrossSection; // CrossSection: current geometry, shared by all defs and visual observer

// --- Observers and controller ---
let visualObserver;   // BeamVisualObserver: all WEBGL rendering
let soundObserver;    // BeamSoundObserver: modal additive synthesis, mono
let controller;       // BeamInteractionController: strike, hold, end-strike

// --- Taper profile state ---
// taperPoints: 5 control points defining the cross-section scale profile.
// xNorm = 0 is the left end, xNorm = 1 is the right end.
// scale = 1.0 everywhere means uniform (prismatic) beam.
let taperPoints = [
  { xNorm: 0.0,  scale: 1.0 },
  { xNorm: 0.25, scale: 1.0 },
  { xNorm: 0.5,  scale: 1.0 },
  { xNorm: 0.75, scale: 1.0 },
  { xNorm: 1.0,  scale: 1.0 }
];
let taperDragIdx = -1;   // index of the control point being dragged (-1 = none)

// --- Timing ---
const BEAM_FR = 60;   // target frame rate (fps)
let baseDt;           // 1 / BEAM_FR -- one physics step per frame
let timeScale = 1.0;  // time scaling (1.0 = real-time physics speed)
let isFrozen  = false;
let isMuted   = false;

// --- Helper mode state ---
let _lastAction   = null;   // most recent named canvas interaction (e.g. 'strike_bending')
let _lastScenario = null;   // most recently applied scenario/material name

// --- Display scale constants ---
// BEND_SCALE: world units per meter of transverse displacement.
// Larger value = more visually amplified bending. Start at 120 (same as membrane Z_SCALE).
const BEND_SCALE = 40;

// EXT_SCALE: world units per meter of axial displacement.
// Extensional amplitudes are typically smaller visually, so a somewhat smaller scale.
const EXT_SCALE = 80;

// Canvas dimensions (set in setup, used by controller and _beamScale).
let cw, ch;

// Current base modal damping ratio (tracked here so VP_STATE can export it
// without needing to reach into the definition internals).
let beamDampBase = 0.01;

// =============================================================================
// setup
// =============================================================================
function setup() {

  // --- Canvas ---
  // Subtract sidebar width so the total page width does not overflow.
  const sidebarEl = document.getElementById('vp-tools');
  const sidebarW  = sidebarEl ? sidebarEl.offsetWidth : 0;
  cw = min(windowWidth - sidebarW, 900);
  ch = round(cw * 0.56);   // slightly wider-than-square aspect for a horizontal rod
  createCanvas(cw, ch, WEBGL).parent('canvas-container');
  const outerEl = document.getElementById('vp-outer');
  if (outerEl) outerEl.style.width = (cw + sidebarW) + 'px';
  frameRate(BEAM_FR);
  baseDt = 1 / BEAM_FR;

  // --- Initial camera ---
  // Eye slightly above and in front of origin, looking at origin.
  // The rotateX(-PI/8) in draw() tilts the beam forward so bending is visible
  // as vertical curve. orbitControl() in draw() lets the user rotate freely.
  camera(0, -80, 400, 0, 0, 0, 0, 1, 0);

  // --- Build physics ---
  // Both definitions use the same L, E, rho, h for consistent material behavior.
  // E=7.4e7 Pa (soft for slow visual): bending f1 ~ 2 Hz, extensional f1 ~ 49 Hz.
  // AUDIO_SCALE=100 maps both to audible range (not used in Step 1).
  // Shared physical parameters for both wave types.
  // E=7.4e7 Pa is deliberately soft (not real steel) to make bending f1 ~ 2 Hz
  // for visual clarity. Real steel (E=200e9) would give f1 ~ 105 Hz -- too fast to see.
  const L           = 1.0;    // beam length (m)
  const E_visual    = 7.4e7;  // Young's modulus (Pa) -- slow-motion visual value
  const rho_steel   = 7800;   // density (kg/m^3)
  const Nx_beam     = 100;    // interior spatial sample points

  // Initial cross-section: 2cm square rod.
  // CrossSection encapsulates A and I; both definitions read from it.
  const initCS = new CrossSection('square', { h: 0.02 });
  currentCrossSection = initCS;

  bendingDef = new BeamBendingDefinition({
    length:        L,
    E:             E_visual,
    rho:           rho_steel,
    crossSection:  initCS,
    bendingAxis:   'y',         // y-bending uses I (depth second moment)
    modes:         12,          // elastic bending modes
    spatialPoints: Nx_beam,
    damping: { base: 0.01, freqScale: 0.002 }
  });

  // Z-bending definition: same parameters but uses I_lateral (width second moment).
  // For isotropic sections (square, circle, tube): same frequencies as Y-bending.
  // For rectangle: different I_lateral gives a distinct pitch -- the "strong vs. weak axis"
  // effect (tall bar is stiff in y-bending, floppy in z; wide bar is the reverse).
  bendingDefZ = new BeamBendingDefinition({
    length:        L,
    E:             E_visual,
    rho:           rho_steel,
    crossSection:  initCS,
    bendingAxis:   'z',         // z-bending uses I_lateral (width second moment)
    modes:         12,
    spatialPoints: Nx_beam,
    damping: { base: 0.01, freqScale: 0.002 }
  });

  extensionalDef = new BeamExtensionalDefinition({
    length:        L,
    E:             E_visual,
    rho:           rho_steel,
    crossSection:  initCS,
    modes:         8,           // elastic extensional modes
    spatialPoints: Nx_beam,
    damping: { base: 0.005, freqScale: 0.001 }
  });

  bendingState    = new ModalState(bendingDef);
  bendingStateZ   = new ModalState(bendingDefZ);
  extensionalState = new ModalState(extensionalDef);

  // --- Build visual observer ---
  // visScale=3.0 (default): cross-section vertex coords (m) are amplified by 3x
  // so the beam looks substantial at default camera distance.
  visualObserver = new BeamVisualObserver({
    Nx:        bendingDef.Nx,
    spatialX:  bendingDef.spatialX,   // shared spatial grid reference
    L:         bendingDef.L,
    visScale:  3.0,
    bendScale: BEND_SCALE,
    extScale:  EXT_SCALE
  });

  // --- Build interaction controller ---
  controller = new BeamInteractionController({
    bendingDef,
    bendingDefZ,
    extensionalDef,
    bendingState,
    bendingStateZ,
    extensionalState,
    bendScale: BEND_SCALE,
    extScale:  EXT_SCALE,
    cw,
    ch
  });

  // --- Build sound observer ---
  // Instantiated here but audio graph is built on the first user gesture
  // (mousePressed or keyPressed) to satisfy the browser autoplay policy.
  soundObserver = new BeamSoundObserver(bendingDef, extensionalDef);

  // --- Initial excitation ---
  // A center strike excites the dispersive bending modes visually.
  // The off-center Gaussian shape will excite both symmetric (odd) and
  // antisymmetric (even) modes, producing a rich initial pattern.
  controller.strikeCenter();

  // --- Shared menu system ---
  // vpBuildMenu creates the tab content. Must run BEFORE _buildUI() so all
  // element IDs (material buttons, display buttons, etc.) exist in the DOM.
  if (window.vpBuildMenu) {
    vpBuildMenu({ world: 'beam', tools: { hold: false }, scenarios: [] });
  }

  // --- window.vpXxx aliases for Menu.js universal controls ---
  window.vpSetTimeScale = function(v) { timeScale = Math.max(0.01, v); };
  window.vpSetDamping   = function(v) {
    beamDampBase = v;
    bendingDef.setDamping(v);
    bendingDefZ.setDamping(v);
    extensionalDef.setDamping(v * 0.5);   // extensional damps at half rate
  };
  window.vpSetDampingSlope = function() { };  // no-op (beam uses uniform damping)
  window.vpZeroState = function() {
    bendingState.q.fill(0);     bendingState.qdot.fill(0);
    bendingStateZ.q.fill(0);    bendingStateZ.qdot.fill(0);
    extensionalState.q.fill(0); extensionalState.qdot.fill(0);
    visualObserver.dispMax = 0.005;
  };
  window.vpToggleMute = function() {
    soundObserver.ensureAudioGraph();
    isMuted = !isMuted;
    soundObserver.setMuted(isMuted);
    // Sync the in-tab mute button if it exists.
    const muteBtn = document.getElementById('mute-btn');
    if (muteBtn) {
      muteBtn.textContent = isMuted ? 'mute: on' : 'mute: off';
      muteBtn.classList.toggle('active', isMuted);
    }
  };
  window.vpSetTool = function(t) {
    // Menu.js uses 'pointer' for the default strike tool.
    controller.tool = (t === 'pointer') ? 'strike' : t;
    _updateToolButtons();
  };

  // --- Build UI ---
  _buildUI();

  // --- Set up taper editor ---
  // _setupTaperEditor() attaches pointer event handlers to #taper-canvas.
  // _drawTaperEditor() renders the initial uniform silhouette.
  _setupTaperEditor();
  _drawTaperEditor();
}

// =============================================================================
// draw -- called at BEAM_FR fps
// =============================================================================
function draw() {

  // --- Step all three physics systems with the same dt ---
  const dt = isFrozen ? 0 : baseDt * timeScale;
  bendingState.step(dt);
  bendingStateZ.step(dt);
  extensionalState.step(dt);

  // --- Hold constraint: zero pinned bending point each frame (both planes) ---
  controller.holdStep();

  // --- Get current physical displacements ---
  const wBend  = bendingState.getDisplacements();      // y-bending (m)
  const wBendZ = bendingStateZ.getDisplacements();     // z-bending (m)
  const uExt   = extensionalState.getDisplacements();  // axial extensional (m)

  // --- Update sound observer ---
  // Combine y-bending and z-bending energies per mode: for isotropic sections the
  // frequencies are identical so the sum is exact; for rectangle it is approximate
  // (both axes drive the same oscillator bank) but acoustically acceptable.
  const bendYEnergies = bendingState.getModalEnergies();
  const bendZEnergies = bendingStateZ.getModalEnergies();
  const combinedBendEnergies = bendYEnergies.map((e, n) => e + bendZEnergies[n]);
  soundObserver.update(
    combinedBendEnergies,
    extensionalState.getModalEnergies()
  );

  // --- Compute dynamic beam scale ---
  // _beamScale() returns world units per meter of beam length.
  // Dynamic so the beam stays the same apparent size as L changes.
  const S = _beamScale();

  // --- WEBGL scene ---
  background(30);   // dark grey matching other worlds

  // --- Camera orbit (suppressed during hold: orbit fights with pin gesture) ---
  if (controller.mode === 'none') {
    orbitControl(3, 3, 0.1);
  }

  // Base tilt: rotate model slightly toward viewer so bending (y-displacement)
  // reads as visible vertical curve rather than a flat line.
  // rotateX(-PI/8) = 22.5 degrees forward tilt.
  rotateX(-PI / 8);

  // --- Update hit-test projections ---
  // Must be called AFTER all transforms and BEFORE any push()/pop().
  // Uses renderer.uModelMatrix, uViewMatrix, uPMatrix for manual MVP projection.
  controller.updateProjections(wBend, uExt, S, this._renderer, cw, ch);

  // --- Render ---
  // All drawing delegated to the visual observer.
  // currentCrossSection provides the vertex layout for the 3D wireframe.
  // bendingDef.scaleProfile is the per-slice cross-section scale array (length Nx).
  // For uniform beams, scaleProfile is all 1.0 and has no visual effect.
  visualObserver.draw(wBend, wBendZ, uExt, S, currentCrossSection, bendingDef.scaleProfile);

  // --- Hover spot ---
  // Draw a filled disk on the beam surface at the face under the mouse cursor.
  // getHoverInfo returns {idx, dyNorm, dzNorm} (the same direction as a click
  // would use), so the spot appears on the correct face of the cross-section.
  // Suppressed during hold (cursor is being used for pinning, not hovering).
  if (controller.mode !== 'holding') {
    const hoverInfo = controller.getHoverInfo(mouseX, mouseY);
    visualObserver.drawHoverSpot(hoverInfo, wBend, wBendZ, uExt, S, currentCrossSection, bendingDef.scaleProfile);
  }


  // --- End-strike mode label ---
  const endEl = document.getElementById('end-strike-label');
  if (endEl) endEl.textContent = controller.endStrikeMode ? 'END STRIKE' : '';

  // --- VP_STATE export for Menu.js poll loop ---
  window.VP_STATE = {
    world:        'beam',
    isMuted:      isMuted,
    isFrozen:     isFrozen,
    timeScale:    timeScale,
    zeta:         [beamDampBase],
    dampingSlope: 0,
    // Map beam tool names to Menu.js convention: 'strike' -> 'pointer'.
    currentTool:  controller.tool === 'strike' ? 'pointer' : controller.tool,
    // Helper mode fields.
    lastAction:   _lastAction,
    lastScenario: _lastScenario
  };
  _lastAction = null;   // consume after one frame
}

// =============================================================================
// _beamScale -- compute world units per meter of beam length, dynamic.
//
// Scales so the beam (length L) fills ~80% of the canvas half-width.
// Approximate: assumes world units ~= canvas pixels at the chosen camera distance.
// Adjust the 0.40 factor if the beam appears too large or small after testing.
// =============================================================================
function _beamScale() {
  // Target: each half-length (L/2) maps to 40% of canvas half-width.
  // For cw=900, L=1m: S = (900 * 0.40) / 0.5 = 720. Visible range ~500 units.
  // At camera z=400: visible half-width ~= 400*tan(PI/6) ~= 231 units.
  // Using 0.22 instead gives: (900*0.22)/0.5 = 396 units total = 85% of visible. Good.
  return (cw * 0.22) / (bendingDef.L / 2);
}

// =============================================================================
// keyPressed -- keyboard shortcuts
// =============================================================================
function keyPressed() {

  // ensureAudioGraph() must run from a user gesture.
  // Calling it on every keypress is safe -- exits immediately if already ready.
  soundObserver.ensureAudioGraph();

  if (key === ' ' || key === 'q' || key === 'Q') {
    // Space or Q: toggle freeze (pause/unpause physics)
    isFrozen = !isFrozen;
    return false;   // prevent page scroll on spacebar
  }

  if (key === 'm' || key === 'M') {
    // M: toggle mute
    isMuted = !isMuted;
    soundObserver.setMuted(isMuted);
    const muteBtn = document.getElementById('mute-btn');
    if (muteBtn) {
      muteBtn.textContent = isMuted ? 'mute: on' : 'mute: off';
      muteBtn.classList.toggle('active', isMuted);
    }
  }

  if (key === 'z' || key === 'Z') {
    // Z: zero -- bring beam to complete rest (no displacement, no velocity).
    bendingState.q.fill(0);
    bendingState.qdot.fill(0);
    bendingStateZ.q.fill(0);
    bendingStateZ.qdot.fill(0);
    extensionalState.q.fill(0);
    extensionalState.qdot.fill(0);
    visualObserver.dispMax = 0.005;   // reset color scale to floor
  }

  if (key === 'r' || key === 'R') {
    // R: reset -- zero all states, re-apply center y-strike
    bendingState.rebuild(bendingDef);
    bendingStateZ.rebuild(bendingDefZ);
    extensionalState.rebuild(extensionalDef);
    controller.strikeCenter();
    visualObserver.dispMax = 0.3;    // reset color scale
  }

  if (key === 'c' || key === 'C') {
    // C: toggle displacement color mode (off = white, on = purple/green)
    visualObserver.toggleColor();
    const colorBtn = document.getElementById('color-btn');
    if (colorBtn) {
      colorBtn.textContent = visualObserver.showColor ? 'color: on' : 'color: off';
      colorBtn.classList.toggle('active', visualObserver.showColor);
    }
  }

  if (key === 'e' || key === 'E') {
    // E: toggle end-strike mode -- next click forces an extensional strike
    controller.endStrikeMode = !controller.endStrikeMode;
  }

  if (key === 'f' || key === 'F') {
    // F: toggle surface mode (wireframe <-> shaded solid)
    visualObserver.toggleSurface();
    const surfBtn = document.getElementById('surface-btn');
    if (surfBtn) {
      surfBtn.textContent = visualObserver.surfaceMode ? 'surface: on' : 'surface: off';
      surfBtn.classList.toggle('active', visualObserver.surfaceMode);
    }
  }

  if (key === 's' || key === 'S') {
    // S: set tool to strike
    controller.tool = 'strike';
    _updateToolButtons();
  }

  if (key === 'h' || key === 'H') {
    // H: set tool to hold
    controller.tool = 'hold';
    _updateToolButtons();
  }

  if (key === 't' || key === 'T') {
    // T: reset taper profile to uniform (all scales = 1.0).
    // Restores the prismatic beam and clears any Rayleigh-Ritz correction.
    _onTaperChange([
      { xNorm: 0.0,  scale: 1.0 },
      { xNorm: 0.25, scale: 1.0 },
      { xNorm: 0.5,  scale: 1.0 },
      { xNorm: 0.75, scale: 1.0 },
      { xNorm: 1.0,  scale: 1.0 }
    ]);
  }
}

// =============================================================================
// Mouse event routing
// =============================================================================
function mousePressed() {
  // ensureAudioGraph() must run from a user gesture to satisfy browser autoplay policy.
  // Safe to call every click -- it exits immediately if already ready.
  soundObserver.ensureAudioGraph();

  const S = _beamScale();

  // onMousePressed returns: 'strike_bending', 'strike_extensional', 'hold', or null.
  const action = controller.onMousePressed(mouseX, mouseY, S);
  if (action) _lastAction = action;   // captured for VP_STATE / HelperMode.js

  // Trigger matching transient noise burst on strikes.
  if (action === 'strike_bending') {
    soundObserver.triggerStrike('side');
  } else if (action === 'strike_extensional') {
    soundObserver.triggerStrike('end');
  }
}

function mouseReleased() {
  controller.onMouseReleased();
}

// =============================================================================
// _applyMaterial -- apply a material preset to both definitions.
//
// Sets E (Young's modulus) and rho (density) on both definitions, then
// recomputes eigenpairs and rebuilds modal coordinates.
//
// All frequencies scale with sqrt(E/rho): doubling E raises all pitches by
// a factor of sqrt(2) (~7 semitones). Quadrupling E gives exactly one octave.
// The ratio of extensional to bending frequencies is fixed by geometry (L/h)
// and does not change with material -- both shift by the same factor.
//
// dampBend and dampExt set the base modal damping ratio for each wave type.
//
// @param {number} E        -- Young's modulus (Pa)
// @param {number} rho      -- density (kg/m^3)
// @param {number} dampBend -- base modal damping ratio for bending
// @param {number} dampExt  -- base modal damping ratio for extensional
// =============================================================================
function _applyMaterial(E, rho, dampBend, dampExt) {
  // Update physical parameters on all three definitions.
  bendingDef.E     = E;    bendingDef.rho     = rho;
  bendingDefZ.E    = E;    bendingDefZ.rho    = rho;
  extensionalDef.E = E;    extensionalDef.rho = rho;

  // recompute() builds new omega, Phi, zeta, spatialX arrays.
  bendingDef.recompute();
  bendingDefZ.recompute();
  extensionalDef.recompute();

  // rebuild() projects current state into new eigenbasis for smooth continuation.
  bendingState.rebuild(bendingDef);
  bendingStateZ.rebuild(bendingDefZ);
  extensionalState.rebuild(extensionalDef);

  // Sync visual observer: spatialX was replaced by recompute().
  visualObserver.spatialX = bendingDef.spatialX;
  visualObserver.L        = bendingDef.L;

  // setDamping() rewrites zeta[] with the new base value.
  // Also sync beamDampBase so VP_STATE.zeta reflects the new damping level.
  beamDampBase = dampBend;
  bendingDef.setDamping(dampBend);
  bendingDefZ.setDamping(dampBend);
  extensionalDef.setDamping(dampExt);

  _updateFreqDisplay();
}

// =============================================================================
// _applyLength -- change beam length on both definitions.
//
// Bending frequencies scale as 1/L^2 (beta_n/L)^2 -- halving L raises
// bending pitch by two octaves. Extensional frequencies scale as 1/L.
// The different scaling is the pedagogical core: length change separates
// the two wave types visually and acoustically.
//
// @param {number} L -- new beam length (m)
// =============================================================================
function _applyLength(L) {
  bendingDef.L     = L;
  bendingDefZ.L    = L;
  extensionalDef.L = L;

  bendingDef.recompute();
  bendingDefZ.recompute();
  extensionalDef.recompute();

  bendingState.rebuild(bendingDef);
  bendingStateZ.rebuild(bendingDefZ);
  extensionalState.rebuild(extensionalDef);

  // Sync visual observer (spatialX and L both changed by recompute).
  visualObserver.spatialX = bendingDef.spatialX;
  visualObserver.L        = bendingDef.L;

  _updateFreqDisplay();
}

// =============================================================================
// _onCrossSectionChange -- swap cross-section geometry and reset both wave types.
//
// Cross-section change affects:
//   - Bending: both frequency (via I/A = kSquared) and mode shape energy distribution.
//   - Extensional: only lumped mass distribution (frequencies unchanged: c_ext = sqrt(E/rho)).
//
// Policy: RESET to rest on cross-section change.
// State projection after a geometry change would use old modal coordinates with
// new mode shapes, producing wrong physical amplitudes. Starting from rest is
// simpler and physically cleaner -- user then strikes the new geometry fresh.
//
// @param {CrossSection} cs -- new cross-section object (already constructed)
// =============================================================================
function _onCrossSectionChange(cs) {
  currentCrossSection = cs;

  // Propagate new geometry to all three physics definitions.
  // setCrossSection() updates A and I (or I_lateral for Z), then calls recompute().
  bendingDef.setCrossSection(cs);
  bendingDefZ.setCrossSection(cs);
  extensionalDef.setCrossSection(cs);

  // Reset all modal states to rest (zero q, qdot, no projection).
  // Cross-section change resets rather than projects: projecting onto new mode
  // shapes with old coordinates would give wrong amplitudes.
  bendingState    = new ModalState(bendingDef);
  bendingStateZ   = new ModalState(bendingDefZ);
  extensionalState = new ModalState(extensionalDef);

  // Sync controller references: it holds direct pointers to the state objects.
  controller.bendingState     = bendingState;
  controller.bendingStateZ    = bendingStateZ;
  controller.extensionalState = extensionalState;

  // Reset color scale so the first strike immediately shows full saturation.
  visualObserver.dispMax = 0.3;

  _updateFreqDisplay();
}

// =============================================================================
// _updateFreqDisplay -- write current audible frequencies to the HTML display.
//
// Reads omega[] from both definitions and shows the audible Hz values
// (physics Hz * AUDIO_SCALE) with frequency ratios that illustrate the
// difference between the n^2 dispersive bending spectrum and the harmonic
// extensional spectrum.
//
// Called after any parameter change (material preset, length slider).
// Not called from draw() to avoid per-frame DOM writes.
// =============================================================================
function _updateFreqDisplay() {
  const el = document.getElementById('freq-display');
  if (!el) return;

  const AUDIO = 100;   // AUDIO_SCALE -- must match BeamSoundObserver.AUDIO_SCALE

  // Bending: first 3 elastic modes (indices 0, 1, 2).
  // omega[n] is in rad/s; divide by 2*pi for Hz, multiply by AUDIO for audible Hz.
  const f1b = bendingDef.omega[0] / (2 * Math.PI) * AUDIO;
  const f2b = bendingDef.omega[1] / (2 * Math.PI) * AUDIO;
  const f3b = bendingDef.omega[2] / (2 * Math.PI) * AUDIO;

  // Ratios show the n^2 (dispersive) spectrum.
  // Free-free beam: f2/f1 = (beta_2/beta_1)^2 = (7.853/4.730)^2 = 2.757
  //                 f3/f1 = (beta_3/beta_1)^2 = (10.996/4.730)^2 = 5.404
  // Compare to string (harmonic): f2/f1 = 2.000, f3/f1 = 3.000.
  const r21b = f2b / f1b;
  const r31b = f3b / f1b;

  // Extensional: first 2 elastic modes (harmonic series: f2/f1 = 2.000 exactly).
  const f1e = extensionalDef.omega[0] / (2 * Math.PI) * AUDIO;
  const f2e = extensionalDef.omega[1] / (2 * Math.PI) * AUDIO;

  el.innerHTML =
    '<span style="color:#666">bending (n\u00b2 spectrum): </span>'
    + '<span style="color:#9dc8f4">'
    + 'f1=' + Math.round(f1b) + ' Hz &nbsp; '
    + 'f2=' + Math.round(f2b) + ' Hz &nbsp; '
    + 'f3=' + Math.round(f3b) + ' Hz &nbsp; '
    + '</span>'
    + '<span style="color:#555">'
    + 'f2/f1=' + r21b.toFixed(2) + ' &nbsp; f3/f1=' + r31b.toFixed(2)
    + '</span>'
    + '&nbsp;&nbsp;&nbsp;&nbsp;'
    + '<span style="color:#666">extensional (harmonic): </span>'
    + '<span style="color:#9dc8f4">'
    + 'f1=' + Math.round(f1e) + ' Hz &nbsp; '
    + '</span>'
    + '<span style="color:#555">'
    + 'f2/f1=' + (f2e / f1e).toFixed(2)
    + '</span>';
}

// =============================================================================
// _onTaperChange -- apply a new taper profile to all three physics definitions.
//
// @param {Array} points -- array of { xNorm, scale } control points.
//
// setTaperProfile() on each definition:
//   1. Interpolates scaleProfile[] from the control points.
//   2. Recomputes A_profile (and I_profile for bending).
//   3. Runs Rayleigh-Ritz to produce new omega and Phi (or restores uniform).
//
// ModalState.step() detects the new omega/Phi references on the next frame
// and auto-rebuilds the state vectors. We also zero the modal coordinates
// explicitly to give a clean start at the new geometry.
// =============================================================================
function _onTaperChange(points) {
  taperPoints = points;

  // Apply taper to both bending definitions and the extensional definition.
  // setTaperProfile() assigns new omega and Phi references -- ModalState will
  // auto-rebuild on the next call to step().
  bendingDef.setTaperProfile(points);
  bendingDefZ.setTaperProfile(points);
  extensionalDef.setTaperProfile(points);

  // Zero all modal coordinates so the tapered beam starts from rest.
  // Projecting old coordinates onto new modes would give wrong amplitudes
  // (the mode shapes changed non-trivially), so clean start is safer.
  bendingState.q.fill(0);     bendingState.qdot.fill(0);
  bendingStateZ.q.fill(0);    bendingStateZ.qdot.fill(0);
  extensionalState.q.fill(0); extensionalState.qdot.fill(0);

  // Reset color scale to floor so the next strike shows fresh color.
  visualObserver.dispMax = 0.005;

  // Redraw the 2D taper editor canvas to reflect the new control points.
  _drawTaperEditor();

  // Update the frequency display box (f1, f2, f3) to show the new modal frequencies.
  // setTaperProfile() assigns new omega references, so they are ready to read here.
  _updateFreqDisplay();
}

// =============================================================================
// _drawTaperEditor -- render the taper profile onto the 2D #taper-canvas.
//
// Canvas: 900 x 80 px. Left/right margins: 15 px. Usable width: 870 px.
// Vertical mapping: scale 2.0 at top (y=5), scale 0.3 at bottom (y=75).
//   y = 5 + (scaleMax - scale) / (scaleMax - scaleMin) * 70
//
// Drawing layers (back to front):
//   1. Reference line at scale=1.0 (the uniform-beam baseline).
//   2. Beam silhouette: filled shape between top/bottom half-height profiles.
//   3. Interpolated profile line connecting the 5 control points.
//   4. Control point dots (6 px radius; highlighted dot if dragging).
//   5. Y-axis scale labels (2.0, 1.0, 0.3) at the left margin.
// =============================================================================
function _drawTaperEditor() {
  const canvas = document.getElementById('taper-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W   = canvas.width;    // 900
  const H   = canvas.height;   // 80

  // Clear to background color.
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, W, H);

  // Layout constants.
  const ML         = 24;               // left margin (px) -- leaves room for scale labels
  const MR         = 8;                // right margin (px)
  const usableW    = W - ML - MR;      // usable width for the beam profile
  const scaleMin   = 0.3;
  const scaleMax   = 2.0;
  const scaleRange = scaleMax - scaleMin;   // 1.7

  // Map a scale value (0.3..2.0) to canvas y-coordinate.
  // scale=2.0 --> y=5 (top), scale=0.3 --> y=75 (bottom).
  const yOfScale = (s) => 5 + (scaleMax - s) / scaleRange * 70;

  // Map a normalized x position (0..1) to canvas x-coordinate.
  const xOfNorm  = (xn) => ML + xn * usableW;

  // --- Reference line at scale=1.0 ---
  const yRef = yOfScale(1.0);
  ctx.strokeStyle = '#333';
  ctx.lineWidth   = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(ML, yRef);
  ctx.lineTo(ML + usableW, yRef);
  ctx.stroke();
  ctx.setLineDash([]);

  // --- Beam silhouette ---
  // For each pixel column across usableW, interpolate the scale profile and draw
  // the top/bottom half-height as a filled shape. halfRef = 12 px for scale=1.0.
  const halfRef = 12;   // half-height of beam silhouette at scale=1.0 (px)
  const yCenter = yOfScale(1.0);   // vertical center of silhouette = scale=1.0 line

  // Build the top and bottom outline arrays by stepping across the usable width.
  // At each x pixel column, interpolate scale from taperPoints and compute y.
  const steps    = usableW;
  const topPts   = [];
  const botPts   = [];
  for (let px = 0; px <= steps; px++) {
    const xNorm = px / steps;

    // Linear interpolation of scale from taperPoints at this xNorm.
    let s = 1.0;
    const pts = taperPoints;
    for (let j = 0; j < pts.length - 1; j++) {
      if (xNorm <= pts[j + 1].xNorm) {
        const t = (xNorm - pts[j].xNorm) / (pts[j + 1].xNorm - pts[j].xNorm);
        s = pts[j].scale + t * (pts[j + 1].scale - pts[j].scale);
        break;
      }
      if (j === pts.length - 2) s = pts[pts.length - 1].scale;
    }

    const x   = ML + px;
    const hh  = halfRef * s;          // half-height at this column (px)
    topPts.push({ x, y: yCenter - hh });
    botPts.push({ x, y: yCenter + hh });
  }

  // Draw filled silhouette (dark teal).
  ctx.fillStyle = 'rgba(30, 80, 80, 0.55)';
  ctx.beginPath();
  ctx.moveTo(topPts[0].x, topPts[0].y);
  for (let px = 1; px <= steps; px++) {
    ctx.lineTo(topPts[px].x, topPts[px].y);
  }
  for (let px = steps; px >= 0; px--) {
    ctx.lineTo(botPts[px].x, botPts[px].y);
  }
  ctx.closePath();
  ctx.fill();

  // Draw silhouette outline (brighter teal).
  ctx.strokeStyle = '#2a8888';
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.moveTo(topPts[0].x, topPts[0].y);
  for (let px = 1; px <= steps; px++) ctx.lineTo(topPts[px].x, topPts[px].y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(botPts[0].x, botPts[0].y);
  for (let px = 1; px <= steps; px++) ctx.lineTo(botPts[px].x, botPts[px].y);
  ctx.stroke();

  // --- Control point connector line ---
  ctx.strokeStyle = '#5599cc';
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  for (let k = 0; k < taperPoints.length; k++) {
    const px = xOfNorm(taperPoints[k].xNorm);
    const py = yOfScale(taperPoints[k].scale);
    if (k === 0) ctx.moveTo(px, py);
    else         ctx.lineTo(px, py);
  }
  ctx.stroke();

  // --- Control point dots ---
  for (let k = 0; k < taperPoints.length; k++) {
    const px       = xOfNorm(taperPoints[k].xNorm);
    const py       = yOfScale(taperPoints[k].scale);
    const isDragging = (k === taperDragIdx);
    ctx.beginPath();
    ctx.arc(px, py, isDragging ? 7 : 5, 0, 2 * Math.PI);
    ctx.fillStyle   = isDragging ? '#88ccff' : '#4a90d9';
    ctx.fill();
    ctx.strokeStyle = '#aadcff';
    ctx.lineWidth   = 1;
    ctx.stroke();
  }

  // --- Y-axis scale labels ---
  ctx.fillStyle  = '#555';
  ctx.font       = '9px Courier New, monospace';
  ctx.textAlign  = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('2.0', ML - 3, yOfScale(2.0));
  ctx.fillText('1.0', ML - 3, yOfScale(1.0));
  ctx.fillText('0.3', ML - 3, yOfScale(0.3));
}

// =============================================================================
// _setupTaperEditor -- attach pointer event handlers to #taper-canvas.
//
// Drag any control point up or down to change its scale (0.3..2.0).
// Hit detection uses a 12 px radius around each control point.
// Calls _onTaperChange() on every pointermove while dragging so the physics
// and the display update in real time.
// =============================================================================
function _setupTaperEditor() {
  const canvas = document.getElementById('taper-canvas');
  if (!canvas) return;

  const W      = canvas.width;    // 900
  const ML     = 24;              // left margin
  const MR     = 8;               // right margin
  const usableW = W - ML - MR;
  const scaleMin   = 0.3;
  const scaleMax   = 2.0;
  const scaleRange = scaleMax - scaleMin;

  // Map canvas y back to scale value.
  // y=5 --> scale=2.0,  y=75 --> scale=0.3.
  const scaleOfY = (y) => {
    let s = scaleMax - (y - 5) / 70 * scaleRange;
    // Clamp to valid range.
    if (s < scaleMin) s = scaleMin;
    if (s > scaleMax) s = scaleMax;
    return s;
  };

  // Map xNorm to canvas x.
  const xOfNorm = (xn) => ML + xn * usableW;

  // Map scale to canvas y.
  const yOfScale = (s) => 5 + (scaleMax - s) / scaleRange * 70;

  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;

    // Find the control point nearest to the pointer within 12 px.
    let bestDist = Infinity;
    let bestIdx  = -1;
    for (let k = 0; k < taperPoints.length; k++) {
      const px   = xOfNorm(taperPoints[k].xNorm);
      const py   = yOfScale(taperPoints[k].scale);
      const dist = Math.sqrt((mx - px) * (mx - px) + (my - py) * (my - py));
      if (dist < bestDist) { bestDist = dist; bestIdx = k; }
    }
    if (bestDist < 12) {
      taperDragIdx = bestIdx;
      canvas.setPointerCapture(e.pointerId);
      _drawTaperEditor();   // highlight the grabbed point immediately
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (taperDragIdx < 0) return;   // not dragging

    const rect  = canvas.getBoundingClientRect();
    const my    = e.clientY - rect.top;
    const newS  = scaleOfY(my);

    // Update the scale of the dragged control point (do NOT move xNorm).
    const newPoints = taperPoints.map((pt, k) =>
      k === taperDragIdx ? { xNorm: pt.xNorm, scale: newS } : { xNorm: pt.xNorm, scale: pt.scale }
    );

    // _onTaperChange updates taperPoints global and calls setTaperProfile on all defs.
    _onTaperChange(newPoints);
  });

  canvas.addEventListener('pointerup', () => {
    taperDragIdx = -1;
    _drawTaperEditor();   // redraw to remove drag highlight
  });
}

// =============================================================================
// _buildUI -- attach event handlers to HTML panel elements.
// =============================================================================
function _buildUI() {

  // --- Strike button ---
  const strikeBtn = document.getElementById('strike-btn');
  if (strikeBtn) {
    strikeBtn.addEventListener('click', () => {
      controller.tool = 'strike';
      _updateToolButtons();
    });
  }

  // --- Hold button ---
  const holdBtn = document.getElementById('hold-btn');
  if (holdBtn) {
    holdBtn.addEventListener('click', () => {
      controller.tool = 'hold';
      _updateToolButtons();
    });
  }

  // --- Color toggle button ---
  const colorBtn = document.getElementById('color-btn');
  if (colorBtn) {
    colorBtn.addEventListener('click', () => {
      visualObserver.toggleColor();
      colorBtn.textContent = visualObserver.showColor ? 'color: on' : 'color: off';
      colorBtn.classList.toggle('active', visualObserver.showColor);
    });
  }

  // --- Surface mode toggle button ---
  const surfBtn = document.getElementById('surface-btn');
  if (surfBtn) {
    surfBtn.addEventListener('click', () => {
      visualObserver.toggleSurface();
      surfBtn.textContent = visualObserver.surfaceMode ? 'surface: on' : 'surface: off';
      surfBtn.classList.toggle('active', visualObserver.surfaceMode);
    });
  }

  // --- Zero button ---
  // Zeroes all modal coordinates and velocities on all three physics states.
  // Brings the beam to complete rest (no displacement, no velocity) without
  // rebuilding the modal basis or applying a new strike.
  const zeroBtn = document.getElementById('zero-btn');
  if (zeroBtn) {
    zeroBtn.addEventListener('click', () => {
      bendingState.q.fill(0);
      bendingState.qdot.fill(0);
      bendingStateZ.q.fill(0);
      bendingStateZ.qdot.fill(0);
      extensionalState.q.fill(0);
      extensionalState.qdot.fill(0);
      visualObserver.dispMax = 0.005;   // floor value -- prevents color scale from stuck-high
    });
  }

  // --- Reset button ---
  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      bendingState.rebuild(bendingDef);
      bendingStateZ.rebuild(bendingDefZ);
      extensionalState.rebuild(extensionalDef);
      controller.strikeCenter();
      visualObserver.dispMax = 0.3;
    });
  }

  // --- Freeze button ---
  const freezeBtn = document.getElementById('freeze-btn');
  if (freezeBtn) {
    freezeBtn.addEventListener('click', () => {
      isFrozen = !isFrozen;
      freezeBtn.textContent = isFrozen ? 'unfreeze' : 'freeze';
      freezeBtn.classList.toggle('active', isFrozen);
    });
  }

  // --- End-strike button ---
  const endBtn = document.getElementById('end-strike-btn');
  if (endBtn) {
    endBtn.addEventListener('click', () => {
      controller.endStrikeMode = !controller.endStrikeMode;
      endBtn.textContent = controller.endStrikeMode ? 'end: on' : 'end: off';
      endBtn.classList.toggle('active', controller.endStrikeMode);
    });
  }

  // --- Length slider ---
  const lengthSlider = document.getElementById('length-slider');
  if (lengthSlider) {
    lengthSlider.addEventListener('input', () => {
      const L = parseFloat(lengthSlider.value);
      document.getElementById('length-label').textContent = L.toFixed(2) + ' m';
      _applyLength(L);
    });
  }

  // --- Damping slider (bending) ---
  const dampSlider = document.getElementById('damp-slider');
  if (dampSlider) {
    dampSlider.addEventListener('input', () => {
      const v = parseFloat(dampSlider.value);
      bendingDef.setDamping(v);
      bendingDefZ.setDamping(v);             // both bending planes share the same damping
      extensionalDef.setDamping(v * 0.5);   // extensional damps at half rate
      document.getElementById('damp-label').textContent = v.toFixed(3);
    });
  }

  // --- Time scale slider ---
  const timeSlider = document.getElementById('time-slider');
  if (timeSlider) {
    timeSlider.addEventListener('input', () => {
      timeScale = parseFloat(timeSlider.value);
      document.getElementById('time-label').textContent = timeScale.toFixed(2) + 'x';
    });
  }

  // --- Material preset buttons ---
  // _applyMatPreset applies the selected material and updates button active states
  // and the damping slider to match the preset's damping value.
  const _applyMatPreset = (btnId, E, rho, dampBend, dampExt) => {
    _applyMaterial(E, rho, dampBend, dampExt);

    // Sync active state on all three material buttons.
    ['mat-metal', 'mat-glass', 'mat-wood'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.classList.toggle('active', id === btnId);
    });

    // Update damping slider to reflect the preset's damping value.
    if (dampSlider) dampSlider.value = dampBend;
    const dampLabel = document.getElementById('damp-label');
    if (dampLabel) dampLabel.textContent = dampBend.toFixed(3);
  };

  const metalBtn = document.getElementById('mat-metal');
  if (metalBtn) {
    metalBtn.addEventListener('click', () => {
      // metal: moderately stiff, long ring. Reference preset (current defaults).
      _applyMatPreset('mat-metal', 7.4e7, 7800, 0.010, 0.005);
      // No extra audio decay -- physics energy drives the audio directly.
      soundObserver.setAudioDecay(1.0);
    });
  }

  const glassBtn = document.getElementById('mat-glass');
  if (glassBtn) {
    glassBtn.addEventListener('click', () => {
      // glass: 4x stiffer --> exactly one octave higher pitch, very low damping.
      // All frequencies scale as sqrt(E/rho): sqrt(4) = 2 = one octave.
      _applyMatPreset('mat-glass', 2.96e8, 7800, 0.003, 0.0015);
      // No extra audio decay -- physics energy drives the audio directly.
      soundObserver.setAudioDecay(1.0);
    });
  }

  const woodBtn = document.getElementById('mat-wood');
  if (woodBtn) {
    woodBtn.addEventListener('click', () => {
      // wood: 1/4 stiffness --> one octave lower pitch, very fast decay.
      // dampBend=0.20 (4x metal): higher modes die in < 1 frame, fundamental in ~0.5s visually.
      // audioDecay=0.90 per frame: audio gain drops to ~4% in 0.5s (30 frames at 60fps)
      // regardless of residual physics energy, removing the metallic ring entirely.
      // This models wood's high acoustic radiation efficiency: structural energy
      // radiates away acoustically much faster than the zeta value alone implies.
      _applyMatPreset('mat-wood', 1.85e7, 7800, 0.20, 0.10);
      soundObserver.setAudioDecay(0.90);
    });
  }

  // --- Cross-section type buttons and parameter sliders ---

  // _buildCSofType -- construct a CrossSection from current slider values for a given type.
  // Reads slider values from the DOM. Converts mm (slider integer) to meters (/1000).
  const _buildCSofType = (type) => {
    if (type === 'square') {
      const h = parseInt(document.getElementById('cs-h').value) / 1000;
      return new CrossSection('square', { h });
    } else if (type === 'circle') {
      const r = parseInt(document.getElementById('cs-r').value) / 1000;
      return new CrossSection('circle', { r });
    } else if (type === 'tube') {
      const ro   = parseInt(document.getElementById('cs-ro').value)   / 1000;
      const wall = parseInt(document.getElementById('cs-wall').value) / 1000;
      // rInner must be strictly less than rOuter for nonzero annular area.
      const ri   = Math.max(0.001, ro - wall);
      return new CrossSection('tube', { rOuter: ro, rInner: ri });
    } else {
      // rectangle
      const width = parseInt(document.getElementById('cs-width').value) / 1000;
      const depth = parseInt(document.getElementById('cs-depth').value) / 1000;
      return new CrossSection('rectangle', { width, depth });
    }
  };

  // _setCsActiveBtn -- update button active classes and show/hide param groups.
  // typeId is 'square', 'circle', 'tube', or 'rect' (button id suffix).
  const _setCsActiveBtn = (typeId) => {
    ['square', 'circle', 'tube', 'rect'].forEach(id => {
      const b = document.getElementById('cs-' + id);
      if (b) b.classList.toggle('active', id === typeId);
    });
    ['square', 'circle', 'tube', 'rect'].forEach(id => {
      const g = document.getElementById('cs-params-' + id);
      if (g) g.style.display = id === typeId ? '' : 'none';
    });
  };

  // Wire cross-section type buttons.
  const csTypes = [
    { id: 'square',  type: 'square'    },
    { id: 'circle',  type: 'circle'    },
    { id: 'tube',    type: 'tube'      },
    { id: 'rect',    type: 'rectangle' }
  ];
  csTypes.forEach(({ id, type }) => {
    const btn = document.getElementById('cs-' + id);
    if (btn) {
      btn.addEventListener('click', () => {
        _setCsActiveBtn(id);
        _onCrossSectionChange(_buildCSofType(type));
      });
    }
  });

  // Wire cross-section parameter sliders. Each slider reads its current type
  // from currentCrossSection.type and rebuilds with all current slider values.
  const _onCSParamChange = () => {
    _onCrossSectionChange(_buildCSofType(currentCrossSection.type));
  };

  // Square slider: h (side length)
  const csHSlider = document.getElementById('cs-h');
  if (csHSlider) {
    csHSlider.addEventListener('input', () => {
      document.getElementById('cs-h-label').textContent = csHSlider.value + ' mm';
      _onCSParamChange();
    });
  }

  // Circle slider: r (radius)
  const csRSlider = document.getElementById('cs-r');
  if (csRSlider) {
    csRSlider.addEventListener('input', () => {
      document.getElementById('cs-r-label').textContent = csRSlider.value + ' mm';
      _onCSParamChange();
    });
  }

  // Tube sliders: rOuter and wall thickness
  const csRoSlider   = document.getElementById('cs-ro');
  const csWallSlider = document.getElementById('cs-wall');
  if (csRoSlider) {
    csRoSlider.addEventListener('input', () => {
      document.getElementById('cs-ro-label').textContent = csRoSlider.value + ' mm';
      _onCSParamChange();
    });
  }
  if (csWallSlider) {
    csWallSlider.addEventListener('input', () => {
      document.getElementById('cs-wall-label').textContent = csWallSlider.value + ' mm';
      _onCSParamChange();
    });
  }

  // Rectangle sliders: width and depth
  const csWidthSlider = document.getElementById('cs-width');
  const csDepthSlider = document.getElementById('cs-depth');
  if (csWidthSlider) {
    csWidthSlider.addEventListener('input', () => {
      document.getElementById('cs-width-label').textContent = csWidthSlider.value + ' mm';
      _onCSParamChange();
    });
  }
  if (csDepthSlider) {
    csDepthSlider.addEventListener('input', () => {
      document.getElementById('cs-depth-label').textContent = csDepthSlider.value + ' mm';
      _onCSParamChange();
    });
  }

  // --- Taper preset buttons ---
  // Each preset calls _onTaperChange() with a predefined set of control points.
  // The resulting scaleProfile shapes the visual silhouette and shifts frequencies.
  //
  // Preset shapes (5 control points: left, 1/4, center, 3/4, right):
  //   uniform: all 1.0 -- prismatic beam, no taper
  //   barrel:  thicker at center, tapered to ends (like a wine barrel)
  //   waist:   thinner at center, wide at ends (like an hourglass)
  //   marimba: slight undercut at center -- approximates marimba bar arch
  //   asym:    monotonically tapered from thick end (left) to thin end (right)
  const _taperPresets = {
    'taper-uniform': [
      { xNorm: 0.0,  scale: 1.0 }, { xNorm: 0.25, scale: 1.0 },
      { xNorm: 0.5,  scale: 1.0 }, { xNorm: 0.75, scale: 1.0 },
      { xNorm: 1.0,  scale: 1.0 }
    ],
    'taper-barrel': [
      { xNorm: 0.0,  scale: 1.0 }, { xNorm: 0.25, scale: 1.3 },
      { xNorm: 0.5,  scale: 1.5 }, { xNorm: 0.75, scale: 1.3 },
      { xNorm: 1.0,  scale: 1.0 }
    ],
    'taper-waist': [
      { xNorm: 0.0,  scale: 1.2 }, { xNorm: 0.25, scale: 0.8 },
      { xNorm: 0.5,  scale: 0.6 }, { xNorm: 0.75, scale: 0.8 },
      { xNorm: 1.0,  scale: 1.2 }
    ],
    'taper-marimba': [
      { xNorm: 0.0,  scale: 1.0 }, { xNorm: 0.25, scale: 0.9 },
      { xNorm: 0.5,  scale: 0.55 }, { xNorm: 0.75, scale: 0.9 },
      { xNorm: 1.0,  scale: 1.0 }
    ],
    'taper-asym': [
      { xNorm: 0.0,  scale: 1.4 }, { xNorm: 0.25, scale: 1.1 },
      { xNorm: 0.5,  scale: 0.9 }, { xNorm: 0.75, scale: 0.7 },
      { xNorm: 1.0,  scale: 0.5 }
    ]
  };

  // Wire each preset button.
  for (const [btnId, pts] of Object.entries(_taperPresets)) {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.addEventListener('click', () => {
        _onTaperChange(pts.map(pt => ({ xNorm: pt.xNorm, scale: pt.scale })));
      });
    }
  }

  // --- Initial frequency display ---
  // Shows audible Hz values and dispersion ratios for current parameters.
  _updateFreqDisplay();

  // --- Mute button ---
  const muteBtn = document.getElementById('mute-btn');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      // Clicking mute is a user gesture -- ensure audio graph is started.
      soundObserver.ensureAudioGraph();
      isMuted = !isMuted;
      soundObserver.setMuted(isMuted);
      muteBtn.textContent = isMuted ? 'mute: on' : 'mute: off';
      muteBtn.classList.toggle('active', isMuted);
    });
  }

  // Set initial button states.
  _updateToolButtons();
}

// =============================================================================
// _updateToolButtons -- sync tool button active states with controller.tool.
// =============================================================================
function _updateToolButtons() {
  const strikeBtn = document.getElementById('strike-btn');
  const holdBtn   = document.getElementById('hold-btn');
  if (strikeBtn) strikeBtn.classList.toggle('active', controller.tool === 'strike');
  if (holdBtn)   holdBtn.classList.toggle('active',   controller.tool === 'hold');
}
