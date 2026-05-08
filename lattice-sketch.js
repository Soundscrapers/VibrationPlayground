/**
 * lattice-sketch.js  (Steps 3-6)
 *
 * p5.js sketch running in WEBGL mode on lattice.html.
 * Separate page from index.html; does not touch the 2D worlds.
 *
 * Responsibility:
 * - Own time (dt) and the physics loop
 * - Build LatticeDefinition and ModalState
 * - Render the lattice: spheres (nodes) + lines (edges) in 3D
 * - Provide orbitControl camera navigation
 * - Coordinate LatticeInteractionController (hit-testing, strike, drag)
 * - Drive LatticeSoundObserver each frame with current displacements
 *
 * Coordinate convention (WEBGL, +y is DOWN in p5):
 *   world x = node.screenX   (q-axis = right)
 *   world y = -node.screenY  (r-axis = UP; flip so higher pitch is higher on screen)
 *   world z = displacement * Z_SCALE  (vibration axis, toward viewer at rest)
 *
 * Camera is set above-and-front in setup(). orbitControl() in draw()
 * lets the user rotate by dragging and zoom by scrolling.
 */

// --- Physics globals ---
let latticeDef;  // LatticeDefinition: owns topology, masses, stiffness, eigenpairs
let modalState;  // ModalState: owns modal coords (q, qdot), steps time

// --- Interaction ---
let controller;  // LatticeInteractionController: hit-testing, strike, mass/stiffness drag

// --- Sound ---
let soundObserver;  // LatticeSoundObserver: one monosynth per node, tonnetz pitches
let isMuted = false;

// --- Visual observer ---
let visualObserver;  // LatticeVisualObserver: draws edges and nodes in WEBGL

// --- Pitch labels ---
// labelMode: 0 = off, 1 = note name only ("A", "E", "C#"),
//            2 = note name + cents from ET ("E +2¢", "C# -14¢")
// Cycles 0 -> 1 -> 2 -> 0 on each 'L' keypress.
let labelMode = 1;
let labelEls  = [];   // cached DOM span references, one per node
let labelHz   = [];   // precomputed JI Hz per node (same formula as LatticeSoundObserver)

// --- Mode energy display ---
let modeCtx = null;   // 2D canvas context for mode energy chart (lazy-initialised)

// --- Timing ---
const FR = 60;    // target frame rate
let baseDt;       // 1 / FR -- base physics step
let timeScale = 1.0;
let isFrozen  = false;

// --- Helper mode state ---
// controller.mode transitions ('none'->'pending'->'drag-mass'/'drag-stiffness') are
// detected in mouseReleased() to infer what the user actually did.
let _lastAction   = null;   // 'drag-mass', 'drag-stiffness', or 'strike'
let _lastScenario = null;   // most recently applied preset name

// --- Rendering parameters ---
// Z_SCALE: pixels per unit of physical displacement.
// Physical displacements are O(0.1-0.5) for a unit strike, so Z_SCALE=120
// gives 12-60 px of visible z-deflection before camera tilt is applied.
// Also passed to LatticeInteractionController so projections stay consistent.
const Z_SCALE = 120;

function setup() {
  // --- Canvas ---
  // WEBGL mode: origin is at canvas CENTER. Right=+x, Down=+y, Toward-viewer=+z.
  // Subtract the sidebar width so the total page width does not overflow.
  const sidebarEl = document.getElementById('vp-tools');
  const sidebarW  = sidebarEl ? sidebarEl.offsetWidth : 0;
  const cw = min(windowWidth - sidebarW, 900);
  const ch = round(cw * 0.72);
  createCanvas(cw, ch, WEBGL).parent('canvas-container');
  const outerEl = document.getElementById('vp-outer');
  if (outerEl) outerEl.style.width = (cw + sidebarW) + 'px';
  frameRate(FR);
  baseDt = 1 / FR;

  // --- Initial camera: above and in front, looking at origin. ---
  // Eye at (0, -400, 500): 400 units above (y negative = up in screen space),
  // 500 units in front (+z = toward viewer). Elevation ~38 degrees from horizontal.
  // orbitControl() in draw() picks this up as the starting orbit position.
  // Additionally, draw() applies rotateX(-PI/5) to the model as a guaranteed
  // base tilt so the grid is seen at an angle even if orbit state resets.
  camera(0, -400, 500, 0, 0, 0, 0, 1, 0);

  // --- Build physics ---
  // 19-node lattice (2 shells), isotropic with all axis stiffnesses equal.
  // spacing=80 pixels: the lattice spans roughly +-180 px horizontally,
  // fitting comfortably in the WEBGL scene at this camera distance.
  latticeDef = new LatticeDefinition({
    shells:  2,     // 19 nodes
    mass:    1,
    kGround: 0,
    kFifth:  150,   // coupling stiffness along perfect-fifth axis
    kThird:  150,   // coupling stiffness along major-third axis
    kMinor:  150,   // coupling stiffness along minor-third axis
    spacing: 80,
    zeta0:   0.02   // baseline modal damping ratio
  });

  modalState = new ModalState(latticeDef);

  // --- Sound observer ---
  // Created here; audio graph is deferred until first user gesture (mousePressed
  // or keyPressed) to satisfy browser autoplay policy.
  soundObserver = new LatticeSoundObserver(latticeDef);

  // --- Interaction controller ---
  // Z_SCALE must match the constant used in draw() so projections are accurate.
  controller = new LatticeInteractionController(latticeDef, modalState, Z_SCALE);

  // --- Visual observer ---
  // Reads latticeDef (edges, stiffness, masses) and controller (hover/hit state).
  // zScale must equal Z_SCALE so node positions in draw() and in the observer match.
  visualObserver = new LatticeVisualObserver({ latticeDef, controller, zScale: Z_SCALE });

  // --- Pitch label overlay ---
  _initLabels();

  // --- Shared menu system ---
  // vpBuildMenu creates the tab content including #mode-btn-row and #mode-canvas.
  // Must run BEFORE _buildModeButtons() so #mode-btn-row exists in the DOM.
  if (window.vpBuildMenu) {
    vpBuildMenu({
      world:     'lattice',
      tools:     { hold: true },
      scenarios: [
        { label: 'isotropic',       onClick: function() { applyPreset('isotropic');       } },
        { label: 'fifth highway',   onClick: function() { applyPreset('fifth-highway');   } },
        { label: 'third highway',   onClick: function() { applyPreset('third-highway');   } },
        { label: 'minor highway',   onClick: function() { applyPreset('minor-highway');   } },
        { label: 'isolated',        onClick: function() { applyPreset('isolated');        } },
        { label: '1 shell (7)',     onClick: function() { _applyShells(1);               } },
        { label: '2 shells (19)',   onClick: function() { _applyShells(2);               } },
        { label: '3 shells (37)',   onClick: function() { _applyShells(3);               } },
      ]
    });
  }

  // Expose activateMode for the scenarios flyout mode grid (built by Menu.js).
  // n is 0-based. Mode 0 is the rigid-body mode; callers should skip it.
  window.vpLaunchLatticeMode = function(n) { activateMode(n); };

  // --- Mode activation buttons ---
  // One button per mode, labelled 1..N, injected into #mode-btn-row.
  // Runs AFTER vpBuildMenu so the container exists.
  _buildModeButtons();

  // Expose axis-slider callback so Menu.js slider rows can reach this sketch.
  window.onAxisSlider = onAxisSlider;

  // --- window.vpXxx aliases for Menu.js universal controls ---
  window.vpSetTimeScale    = function(v) { timeScale = Math.max(0.01, v); };
  window.vpSetDamping      = function(v) {
    if (!latticeDef) return;
    latticeDef.zeta0 = v;
    latticeDef.recompute();
    modalState.rebuild(latticeDef);
  };
  window.vpSetDampingSlope = function(v) {
    if (!latticeDef) return;
    latticeDef.dampingSlope = v;
    latticeDef.recompute();
    modalState.rebuild(latticeDef);
  };
  window.vpZeroState = function() {
    const N = latticeDef.size();
    const z = new Array(N).fill(0);
    modalState.setPhysicalState(z, z);
    _clearModeHighlight();
  };
  window.vpToggleMute = function() {
    isMuted = !isMuted;
    if (typeof Tone !== 'undefined' && Tone.Destination) Tone.Destination.mute = isMuted;
  };
  window.vpSetTool    = function(name) { if (controller) controller.setTool(name); };
  window.vpApplyShells = _applyShells;   // exposed so Menu.js geometry buttons can call it

  // vpToggleTuning -- flip between just intonation and equal temperament.
  // Called by both the 'T' key handler and the Sound tab toggle button.
  // Sets the new mode on the sound observer (hot-retunes if audio is running),
  // invalidates the label cache so _updateLabels() rewrites text next frame,
  // and syncs the Sound-tab button label.
  window.vpToggleTuning = function() {
    const newMode = (soundObserver.tuningMode === 'ji') ? 'et' : 'ji';
    soundObserver.setTuning(newMode);

    // Invalidate label cache so _updateLabels() rewrites on the next draw().
    // Clearing dataset.lmode causes the per-element branch to fire once.
    for (let i = 0; i < labelEls.length; i++) {
      labelEls[i].dataset.lmode = '';
    }

    // Sync the Sound-tab button label and active state.
    const btn = document.getElementById('btn-tuning-toggle');
    if (btn) {
      btn.textContent = (newMode === 'ji') ? 'just' : '12-TET';
      btn.classList.toggle('active', newMode === 'et');
    }

    // Sync the info-bar hint span below the canvas.
    const hint = document.getElementById('tuning-hint');
    if (hint) {
      hint.textContent = (newMode === 'ji') ? 'T tuning: just' : 'T tuning: 12-TET';
    }
  };

  // --- Initial condition: displace center node (index 0) ---
  // This injects energy into the lattice; it propagates outward through couplings.
  // x[0]=0.5 puts the center node 0.5 units above equilibrium; all others at rest.
  _strikeCenter();
}

function draw() {
  const dt = isFrozen ? 0 : baseDt * timeScale;

  // --- Step physics ---
  modalState.step(dt);

  // --- Get current physical displacements and velocities (length N, one per node) ---
  // x[i] = sum_n  Phi[i][n] * q[n]    (modal superposition, position)
  // v[i] = sum_n  Phi[i][n] * qdot[n] (modal superposition, velocity)
  const disp = modalState.getDisplacements();
  const vel  = modalState.getVelocities();

  // --- Remove rigid-body drift (mean subtraction) ---
  // With kGround=0 the uniform mode has omega=0: no restoring force, no damping.
  // Any energy in that mode produces a constant offset or linear drift that
  // makes the whole lattice translate as a unit.  Subtracting the mean
  // displacement re-centers the display on the lattice's own center of mass
  // each frame.  Only the zero mode contributes to the mean (all higher modes
  // are orthogonal to the uniform vector and sum to zero across nodes).
  // The wave content (all non-uniform modes) is unaffected.
  let dispSum = 0;
  for (let i = 0; i < disp.length; i++) dispSum += disp[i];
  const dispMean = dispSum / disp.length;
  for (let i = 0; i < disp.length; i++) disp[i] -= dispMean;

  // ---- WEBGL scene ----
  background(30);   // dark grey matching other worlds

  // Camera orbit:
  // - Orbit runs when no node/edge is grabbed (controller.mode === 'none').
  // - Once controller.pointerDown() grabs a node or edge, mode goes non-'none'
  //   and orbit is suppressed for the duration of that drag.
  // - A click that misses all nodes/edges leaves mode === 'none', so the same
  //   drag becomes an orbit -- no Shift required.
  if (controller.mode === 'none') {
    orbitControl(3, 3, 0.1);
  }

  // Base model tilt: rotate the lattice so the grid plane is seen at an angle
  // and z-displacement is visible as vertical motion on screen.
  // rotateX(-PI/5) = 36 degrees forward tilt. MODEL-space rotation -- does not
  // affect orbitControl's camera state, so orbit still works after this call.
  rotateX(-PI / 5);

  // Update hit-test projections AFTER all transforms are applied.
  // screenX/Y use the current model-view matrix, so this must come AFTER
  // rotateX() and BEFORE any push()/pop() that modifies the transform.
  // Project all nodes/edges from 3D world space to 2D canvas pixels.
  // Pass the renderer and canvas dimensions so the controller can do the
  // full MVP transform without depending on p5's screenX/screenY (which
  // do not exist in this p5 build and could not be globals anyway due to
  // the browser's own window.screenX / window.screenY built-ins).
  controller.updateProjections(disp, this._renderer, width, height);

  // Lighting: ambient base keeps shadow regions visible;
  // directional from above-front gives spheres visible depth.
  ambientLight(50);
  directionalLight(210, 210, 210, 0.5, 0.5, -1);  // direction (0.5, 0.5, -1) = front-above

  // --- Draw lattice (edges then nodes) ---
  // LatticeVisualObserver reads latticeDef and controller; never mutates them.
  visualObserver.draw(disp);

  // --- Update pitch label positions ---
  // Repositions each label span to the node's current projected screen coord.
  // Uses controller.nodeProj which was computed above (post-transform).
  _updateLabels();

  // --- Mode energy chart ---
  // Draws a bar-per-mode chart on the 2D canvas below the controls.
  _drawModeEnergy();

  // --- Update sound observer ---
  // Passes velocities so each node's oscillator gain tracks |vel[i]|.
  // Velocity-driven gain silences slow-drifting nodes (large disp, low vel)
  // while correctly amplifying fast-moving ones.
  // Called unconditionally (even when frozen) so the audio holds its frozen level.
  soundObserver.update(disp, vel);

  // --- VP_STATE export for Menu.js poll loop ---
  // Read each frame; Menu.js uses this to sync sliders, mute button, tool highlights.
  window.VP_STATE = {
    world:        'lattice',
    isMuted:      isMuted,
    isFrozen:     isFrozen,
    timeScale:    timeScale,
    zeta:         latticeDef ? [latticeDef.zeta0] : [0.02],
    dampingSlope: latticeDef ? latticeDef.dampingSlope : 0,
    currentTool:  controller ? controller.currentTool : 'pointer',
    kFifth:       latticeDef ? latticeDef.kFifth  : 150,
    kThird:       latticeDef ? latticeDef.kThird  : 150,
    kMinor:       latticeDef ? latticeDef.kMinor  : 150,
    shells:           latticeDef ? latticeDef.shells  : 2,
    latticeModeCount: latticeDef ? latticeDef.omega.length : 0,
    // Modal frequencies in Hz (one per mode). Used by Menu.js to populate
    // the frequency list below the mode-shape buttons in the Physics tab.
    latticeFreqs: latticeDef ? latticeDef.omega.map(w => w / (2 * Math.PI)) : [],
    tuningMode:       soundObserver ? soundObserver.tuningMode : 'ji',
    // Helper mode fields.
    lastAction:   _lastAction,
    lastScenario: _lastScenario
  };
  _lastAction = null;   // consume after one frame
}

// ---------------------------------------------------------------------------
// _strikeCenter -- set center node to x=0.5, all else at rest.
// Called on load and on 'R' key press.
// ---------------------------------------------------------------------------
function _strikeCenter() {
  const N = latticeDef.size();
  const x0 = new Array(N).fill(0);
  const v0 = new Array(N).fill(0);
  x0[0] = 0.5;   // center node (index 0) displaced 0.5 units
  modalState.setPhysicalState(x0, v0);
  _clearModeHighlight();
}

// ---------------------------------------------------------------------------
// activateMode -- excite a single mode in isolation.
//
// Sets modal coordinate n to amplitude MODE_AMP and all others to zero,
// with zero velocities.  The physical displacement of node i is then:
//   x[i] = Phi[i][n] * MODE_AMP
//
// Phi[:,n] is mass-normalised: sum_i Phi[i][n]^2 = 1 (for unit mass).
// With N=19 nodes, the RMS of Phi[:,n] is 1/sqrt(19) ~= 0.23.
// MODE_AMP=1.0 gives peak node displacements of roughly 0.3-0.7 units
// (36-84 px at Z_SCALE=120), clearly visible for all non-zero modes.
//
// Mode 0 (index 0) is the zero-frequency rigid-body mode: omega=0, Phi[:,0]
// is uniform.  Activating it sets all nodes to the same displacement, which
// the mean-subtraction in draw() cancels to zero -- the lattice appears
// motionless.  This is correct: mode 0 carries no relative motion.
// ---------------------------------------------------------------------------
const MODE_AMP = 1.0;

function activateMode(n) {
  if (n < 0 || n >= modalState.N) return;
  for (let i = 0; i < modalState.N; i++) {
    modalState.q[i]    = (i === n) ? MODE_AMP : 0;
    modalState.qdot[i] = 0;
  }
  // Highlight the active button; clear all others.
  _clearModeHighlight();
  const btns = document.querySelectorAll('#mode-btn-row button');
  if (btns[n]) btns[n].classList.add('active');
}

// ---------------------------------------------------------------------------
// _clearModeHighlight -- remove the active-mode button highlight.
// Called by _strikeCenter() and scenario keys so the UI stays consistent.
// ---------------------------------------------------------------------------
function _clearModeHighlight() {
  document.querySelectorAll('#mode-btn-row button')
          .forEach(b => b.classList.remove('active'));
}

// ---------------------------------------------------------------------------
// Axis stiffness presets and controls
// (Moved from lattice.html inline <script> so setup() can reference these
//  functions before vpBuildMenu() calls setup() with scenario onClick entries.)
// ---------------------------------------------------------------------------

// Named stiffness configurations for the three tonnetz coupling axes.
// fifth  = horizontal coupling, perfect fifth interval (ratio 3/2)
// third  = upper-right diagonal, major third interval (ratio 5/4)
// minor  = lower-right diagonal, minor third interval (ratio 6/5)
const LATTICE_PRESETS = {
  'isotropic':       { fifth: 150, third: 150, minor: 150 },
  'fifth-highway':   { fifth: 150, third:  10, minor:  10 },
  'third-highway':   { fifth:  10, third: 150, minor:  10 },
  'minor-highway':   { fifth:  10, third:  10, minor: 150 },
  'parallel-fifths': { fifth:  50, third:   0, minor:   0 },
  'isolated':        { fifth:   1, third:   1, minor:   1 }
};

// onAxisSlider -- called by Menu.js axis slider input events.
// axis: 'fifth' | 'third' | 'minor'
// val:  new stiffness value (0..200)
function onAxisSlider(axis, val) {
  latticeDef.setAxisStiffness(axis, val);
  modalState.rebuild(latticeDef);
  const valEl = document.getElementById('kv-' + axis);
  if (valEl) valEl.textContent = Math.round(val);
}

// applyPreset -- load a named stiffness configuration and re-strike center.
function applyPreset(name) {
  _lastScenario = name;   // captured for VP_STATE / HelperMode.js
  const p = LATTICE_PRESETS[name];
  if (!p) return;
  latticeDef.setAxisStiffness('fifth', p.fifth);
  latticeDef.setAxisStiffness('third', p.third);
  latticeDef.setAxisStiffness('minor', p.minor);
  modalState.rebuild(latticeDef);
  _syncSliders();
  _strikeCenter();
}

// _syncSliders -- push current kFifth/kThird/kMinor values from latticeDef into
// the slider input elements and their value spans.
// Called after applyPreset() and keyboard scenario shortcuts.
function _syncSliders() {
  const axes = { fifth: 'kFifth', third: 'kThird', minor: 'kMinor' };
  for (const [axis, key] of Object.entries(axes)) {
    const val   = Math.round(latticeDef[key]);
    const slEl  = document.getElementById('k-' + axis);
    const valEl = document.getElementById('kv-' + axis);
    if (slEl)  slEl.value = val;
    if (valEl) valEl.textContent = val;
  }
}

// ---------------------------------------------------------------------------
// _applyShells -- rebuild the lattice with n shells, preserving current axis
// stiffness values and damping ratio.
//
// Shell counts and node totals:
//   n=1  -->   7 nodes (center + 1 ring)
//   n=2  -->  19 nodes (center + 2 rings)
//   n=3  -->  37 nodes (center + 3 rings)
//
// Tears down sound (one oscillator per node) before changing topology, then
// rebuilds everything from scratch so node indices stay consistent.
// ---------------------------------------------------------------------------
function _applyShells(n) {
  // Preserve current settings before teardown.
  const k5    = latticeDef ? latticeDef.kFifth        : 150;
  const k3    = latticeDef ? latticeDef.kThird        : 150;
  const km    = latticeDef ? latticeDef.kMinor        : 150;
  const zeta0 = latticeDef ? latticeDef.zeta0         : 0.02;
  const slope = latticeDef ? latticeDef.dampingSlope  : 0;

  // Dispose all per-node oscillators before node count changes.
  if (soundObserver) soundObserver.dispose();

  // Rebuild physics with new shell count, preserving all tuning parameters.
  latticeDef = new LatticeDefinition({
    shells:        n,
    mass:          1,
    kGround:       0,
    kFifth:        k5,
    kThird:        k3,
    kMinor:        km,
    spacing:       80,
    zeta0:         zeta0,
    dampingSlope:  slope
  });
  modalState     = new ModalState(latticeDef);
  controller     = new LatticeInteractionController(latticeDef, modalState, Z_SCALE);
  visualObserver = new LatticeVisualObserver({ latticeDef, controller, zScale: Z_SCALE });

  // New sound observer for the updated node count.
  soundObserver = new LatticeSoundObserver(latticeDef);

  // Re-init pitch label spans (count has changed).
  _initLabels();

  // Re-build mode buttons for new modal count.
  _buildModeButtons();

  // Start with center node displaced.
  _strikeCenter();
}

// ---------------------------------------------------------------------------
// _buildModeButtons -- create one button per mode in #mode-btn-row.
// Called from setup() after latticeDef and modalState are ready.
// Buttons are labelled 1..N (1-based).  Each calls activateMode(n) where
// n is the 0-based modal index.
// ---------------------------------------------------------------------------
function _buildModeButtons() {
  const row = document.getElementById('mode-btn-row');
  if (!row) return;
  row.innerHTML = '';
  for (let n = 0; n < modalState.N; n++) {
    const btn = document.createElement('button');
    btn.textContent = String(n + 1);

    // Rigid-body mode: omega near zero means no restoring force (kGround=0).
    // Activating it just translates the whole lattice -- not musically useful.
    // Disable the button so it is greyed out and unclickable.
    const isRigidBody = latticeDef.omega[n] < 0.1;
    if (isRigidBody) {
      btn.disabled = true;
      btn.title = 'mode ' + (n + 1) + '  -- rigid-body mode (omega ~ 0, no restoring force)';
    } else {
      btn.title = 'mode ' + (n + 1) + '  \u03c9 = ' + latticeDef.omega[n].toFixed(1) + ' rad/s';
      btn.onclick = () => activateMode(n);
    }

    row.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Scenario helpers (used by number-key handlers)
// ---------------------------------------------------------------------------

// _nodeShell -- return the hex shell index (0, 1, 2, ...) for node i.
// Uses the hex Chebyshev distance: max(|q|, |r|, |q+r|).
//   Shell 0: only the center (q=0, r=0)
//   Shell 1: 6 nodes forming the inner ring  (max distance = 1)
//   Shell 2: 12 nodes forming the outer ring (max distance = 2)
function _nodeShell(i) {
  const { q, r } = latticeDef.nodePositions[i];
  return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
}

// _applyEdgeStiffness -- set per-edge stiffness by shell category, recompute once.
//
// Categorizes every edge by the maximum shell index of its two endpoints:
//   'inner'    -- both nodes in shell <= 1 (center + first ring)
//   'coupling' -- spans the shell-1/shell-2 boundary (one node in each)
//   'outer'    -- both nodes in shell 2
//
// Sets latticeDef.stiffness directly for all edges, then calls recompute()
// once (rather than calling setCoupling per edge, which would recompute N times).
// Does NOT update kFifth/kThird/kMinor because stiffness now varies per edge
// within each axis -- the sliders are left at their previous values.
//
// @param {number} inner    -- stiffness for center + inner-ring edges
// @param {number} coupling -- stiffness for inner-to-outer-ring edges
// @param {number} outer    -- stiffness for outer-ring-only edges
function _applyEdgeStiffness(inner, coupling, outer) {
  for (const edge of latticeDef.edges) {
    const si = _nodeShell(edge.i);
    const sj = _nodeShell(edge.j);
    let k;
    if (si <= 1 && sj <= 1) {
      k = inner;          // both nodes inside or at center
    } else if (si === 2 && sj === 2) {
      k = outer;          // both nodes on the outer ring
    } else {
      k = coupling;       // edge crosses the shell-1/shell-2 boundary
    }
    latticeDef.stiffness[edge.i][edge.j] = k;
    latticeDef.stiffness[edge.j][edge.i] = k;
  }
  // Single recompute after all edges are set.
  latticeDef.recompute();
  modalState.rebuild(latticeDef);
}

// ---------------------------------------------------------------------------
// Mouse / pointer event handlers
// ---------------------------------------------------------------------------

function mousePressed() {
  // Ignore clicks outside the canvas.
  if (mouseX < 0 || mouseX > width || mouseY < 0 || mouseY > height) return;

  // First interaction: start the Web Audio context (browser autoplay policy).
  soundObserver.ensureAudioGraph();

  // Always forward to controller -- it checks for a node/edge hit internally.
  // If nothing is hit, mode stays 'none' and the drag becomes an orbit in draw().
  controller.pointerDown(mouseX, mouseY);
}

// mouseMoved fires when mouse moves with NO button held (hover updates).
function mouseMoved() {
  if (mouseX < 0 || mouseX > width || mouseY < 0 || mouseY > height) {
    controller.clearHover();
    return;
  }
  controller.pointerMove(mouseX, mouseY);
}

// mouseDragged fires when mouse moves WITH a button held (drag updates).
function mouseDragged() {
  if (mouseX < 0 || mouseX > width || mouseY < 0 || mouseY > height) return;
  // Only forward to controller if it already owns this drag (started with Shift).
  // Otherwise the drag is an orbit and orbitControl handles it in draw().
  if (controller.mode !== 'none') {
    controller.pointerMove(mouseX, mouseY);
  }
}

function mouseReleased() {
  // Only forward to controller if it owns an active interaction.
  if (controller.mode !== 'none') {
    // Capture what kind of interaction just completed before handing off.
    // controller.mode is 'drag-mass', 'drag-stiffness', or 'pending' (quick tap = strike).
    if (controller.mode === 'drag-mass')       _lastAction = 'drag-mass';
    else if (controller.mode === 'drag-stiffness') _lastAction = 'drag-stiffness';
    else if (controller.mode === 'pending')    _lastAction = 'strike';
    controller.pointerUp(mouseX, mouseY);
  }
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
function keyPressed() {
  // Any keypress: start audio if not yet running (handles keyboard-first users).
  soundObserver.ensureAudioGraph();

  if (key === ' ' || key === 'q' || key === 'Q') {
    // Spacebar or Q: toggle freeze
    isFrozen = !isFrozen;
  }
  if (key === 'r' || key === 'R') {
    // R: reset -- re-strike center node
    _strikeCenter();
  }
  if (key === 'm' || key === 'M') {
    // M: toggle mute
    isMuted = !isMuted;
    if (Tone && Tone.Destination) Tone.Destination.mute = isMuted;
  }
  if (key === 'l' || key === 'L') {
    // L: cycle label mode   0 (off) --> 1 (note names) --> 2 (note names + cents) --> 0
    labelMode = (labelMode + 1) % 3;
    // Update the info-bar hint so the user sees the current state.
    const hint = document.getElementById('label-mode-hint');
    if (hint) {
      const states = ['off', 'names', 'names+\u00a2'];  // ¢ = U+00A2
      hint.textContent = 'L labels: ' + states[labelMode];
    }
  }
  if (key === 't' || key === 'T') {
    // T: toggle tuning between just intonation and equal temperament.
    // Delegates to vpToggleTuning() which handles sound, labels, and button sync.
    if (window.vpToggleTuning) window.vpToggleTuning();
  }
  if (key === 'h' || key === 'H') {
    // H: toggle between pointer and hold tool (matches 2D worlds).
    if (controller) {
      const next = controller.currentTool === 'hold' ? 'pointer' : 'hold';
      controller.setTool(next);
    }
  }
  // 1-9: load a tonal-pathway scenario.
  // Each scenario sets edge stiffnesses and re-strikes to inject energy.
  // Axis-uniform scenarios (1, 2, 5, 6, 7) also update the axis sliders.
  // Per-shell scenarios (3, 4, 8, 9) set individual edge stiffnesses --
  // the axis sliders are left at their last state because different edges
  // on the same axis can have different stiffnesses in these configurations.
  if (key === '1') {
    // 1 -- uniform, very stiff: all axes at near-maximum coupling.
    // High stiffness raises all natural frequencies; energy propagates
    // quickly in all directions with tight harmonic coupling.
    latticeDef.setAxisStiffness('fifth', 180);
    latticeDef.setAxisStiffness('third', 180);
    latticeDef.setAxisStiffness('minor', 180);
    modalState.rebuild(latticeDef);
    _syncSliders();
    _strikeCenter();
  }
  if (key === '2') {
    // 2 -- uniform, loose: all axes at low stiffness.
    // Low frequencies, slow propagation, modes are more widely spaced.
    latticeDef.setAxisStiffness('fifth', 15);
    latticeDef.setAxisStiffness('third', 15);
    latticeDef.setAxisStiffness('minor', 15);
    modalState.rebuild(latticeDef);
    _syncSliders();
    _strikeCenter();
  }
  if (key === '3') {
    // 3 -- inner hexagon loose, outer shell stiff, coupling medium.
    // The center cluster resonates slowly; the outer ring resonates quickly.
    // Energy must cross the medium-stiffness boundary to transfer between zones.
    _applyEdgeStiffness(15, 80, 180);
    _strikeCenter();
  }
  if (key === '4') {
    // 4 -- reverse of 3: inner stiff, outer loose, coupling medium.
    // The inner cluster rings fast; the outer shell lumbers slowly.
    _applyEdgeStiffness(180, 80, 15);
    _strikeCenter();
  }
  if (key === '5') {
    // 5 -- fifth axis loose, third and minor axes stiff.
    // Energy moves freely along the circle-of-fifths (horizontal) but is
    // resisted across the major-third and minor-third diagonals.
    latticeDef.setAxisStiffness('fifth', 15);
    latticeDef.setAxisStiffness('third', 150);
    latticeDef.setAxisStiffness('minor', 150);
    modalState.rebuild(latticeDef);
    _syncSliders();
    _strikeCenter();
  }
  if (key === '6') {
    // 6 -- third axis loose, fifth and minor axes stiff.
    // Energy flows along the major-third diagonal; fifths and minor thirds resist.
    latticeDef.setAxisStiffness('fifth', 150);
    latticeDef.setAxisStiffness('third', 15);
    latticeDef.setAxisStiffness('minor', 150);
    modalState.rebuild(latticeDef);
    _syncSliders();
    _strikeCenter();
  }
  if (key === '7') {
    // 7 -- minor axis loose, fifth and third axes stiff.
    // Energy flows along the minor-third diagonal; the implicit minor-third
    // pathway (dq+dr=0) becomes the path of least resistance.
    latticeDef.setAxisStiffness('fifth', 150);
    latticeDef.setAxisStiffness('third', 150);
    latticeDef.setAxisStiffness('minor', 15);
    modalState.rebuild(latticeDef);
    _syncSliders();
    _strikeCenter();
  }
  if (key === '8') {
    // 8 -- radial gradient: stiffness increases from center outward.
    // Inner edges (shell 0-1): very soft -- center resonates slowly.
    // Coupling edges (shell 1-2 boundary): medium.
    // Outer edges (shell 2-2): stiff -- outer ring resonates quickly.
    // Creates a dispersive medium: wavefront accelerates as it spreads outward.
    _applyEdgeStiffness(20, 100, 180);
    _strikeCenter();
  }
  if (key === '9') {
    // 9 -- outer ring resonator: only the outer ring edges are stiff.
    // All interior and coupling connections are very loose, isolating the
    // outer 12-node hexagonal ring as a nearly independent resonator.
    // Strike an outer-ring node (index 7, shell-2) to excite the ring directly.
    _applyEdgeStiffness(10, 10, 200);
    const N = latticeDef.size();
    const x0 = new Array(N).fill(0);
    const v0 = new Array(N).fill(0);
    x0[7] = 0.5;   // shell-2 node; energy circulates the outer ring
    modalState.setPhysicalState(x0, v0);
    _clearModeHighlight();
  }
}

// ---------------------------------------------------------------------------
// Pitch label helpers
// ---------------------------------------------------------------------------

// _noteNameFromAxial -- derive equal-temperament pitch class name from (q, r).
//
// Root node at (q=0, r=0) = A (pitch class 9 in chromatic numbering C=0..B=11).
// Each step along q-axis = perfect fifth = +7 semitones in ET.
// Each step along r-axis = major third   = +4 semitones in ET.
//
// formula: pc = (9 + q*7 + r*4) mod 12
//
// Verified:  (1,0)=E, (-1,0)=D, (0,1)=C#, (0,-1)=F,
//            (1,-1)=C (minor third up from A), (-1,1)=F# (minor third down from A)
function _noteNameFromAxial(q, r) {
  const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  // The +12 before the outer mod guards against JavaScript's negative-remainder
  // behaviour: (-5 % 12) = -5 in JS, so ((x % 12) + 12) % 12 always gives 0..11.
  const pc = ((9 + q * 7 + r * 4) % 12 + 12) % 12;
  return NOTE_NAMES[pc];
}

// _initLabels -- create one <span> per node in #label-layer.
// Also precomputes labelHz[i] (tonnetz JI pitch) for the cents display.
// Called once from setup() after latticeDef is built.
function _initLabels() {
  const layer = document.getElementById('label-layer');
  if (!layer) return;
  layer.innerHTML = '';
  labelEls = [];
  labelHz  = [];

  const rootHz = 220;   // A3 -- matches LatticeSoundObserver
  const minHz  = 110;   // A2  (octave fold floor)
  const maxHz  = 1760;  // A6  (octave fold ceiling)

  for (let i = 0; i < latticeDef.size(); i++) {
    const { q, r } = latticeDef.nodePositions[i];

    // Precompute JI pitch (same formula as LatticeSoundObserver._buildPitchTable).
    let hz = rootHz * Math.pow(3 / 2, q) * Math.pow(5 / 4, r);
    while (hz > maxHz) hz /= 2;
    while (hz < minHz) hz *= 2;
    labelHz[i] = hz;

    const span = document.createElement('span');
    span.className   = 'node-label';
    span.textContent = _noteNameFromAxial(q, r);  // initial text; updated by _updateLabels
    layer.appendChild(span);
    labelEls.push(span);
  }
}

// _updateLabels -- reposition each label and update text for the current labelMode.
// labelMode 0: hidden
// labelMode 1: note name only  ("A", "E", "C#")
// labelMode 2: note name + cents from ET ("E +2¢", "C# -14¢")
function _updateLabels() {
  for (let i = 0; i < labelEls.length; i++) {
    if (labelMode === 0) {
      labelEls[i].style.display = 'none';
      continue;
    }
    labelEls[i].style.display = '';
    labelEls[i].style.left = controller.nodeProj[i].sx + 'px';
    labelEls[i].style.top  = controller.nodeProj[i].sy + 'px';

    // Update text content only when labelMode or tuningMode changes, not every frame.
    // Cache key encodes both so a tuning toggle triggers a rewrite even if
    // labelMode hasn't changed (vpToggleTuning() clears this to '' to force it).
    const tuning  = soundObserver ? soundObserver.tuningMode : 'ji';
    const cacheKey = labelMode + ':' + tuning;
    if (labelEls[i].dataset.lmode !== cacheKey) {
      const { q, r } = latticeDef.nodePositions[i];
      // labelMode 2 in JI: show note name + cents deviation from ET.
      // labelMode 2 in ET: cents are all 0 -- suppress them, show name only.
      labelEls[i].textContent = (labelMode === 2 && tuning === 'ji')
        ? _notePlusCents(q, r, labelHz[i])
        : _noteNameFromAxial(q, r);
      labelEls[i].dataset.lmode = cacheKey;
    }
  }
}

// _notePlusCents -- return "E +2¢" style label.
// Computes cents deviation of the JI pitch hz from the nearest ET pitch,
// referenced to A4 = 440 Hz.
//
// Example values for 2-shell lattice (root A2 = 110 Hz):
//   A  (q=0,r=0): 110 Hz   --> A2 ET = 110 Hz   --> 0¢
//   E  (q=1,r=0): 165 Hz   --> E3 ET = 164.81 Hz --> +2¢
//   C# (q=0,r=1): 137.5 Hz --> C#3 ET = 138.59 Hz --> -14¢
//   C  (q=1,r=-1): 132 Hz  --> C3 ET = 130.81 Hz  --> +16¢  (JI m3 vs ET m3)
function _notePlusCents(q, r, hz) {
  const A4 = 440;
  // Nearest ET semitone count (may be negative for pitches below A4).
  const semFromA4 = Math.round(12 * Math.log2(hz / A4));
  const etHz = A4 * Math.pow(2, semFromA4 / 12);
  const cents = Math.round(1200 * Math.log2(hz / etHz));
  const sign  = (cents >= 0) ? '+' : '';
  return _noteNameFromAxial(q, r) + ' ' + sign + cents + '\u00a2';  // ¢ = U+00A2
}

// ---------------------------------------------------------------------------
// Mode energy chart
// ---------------------------------------------------------------------------

// _drawModeEnergy -- draw one horizontal bar per mode on #mode-canvas.
//
// Bar width = E_n / E_max (normalised to the most energetic mode this frame).
// Energy in mode n:  E_n = (1/2) * omega_n^2 * q_n^2  +  (1/2) * qdot_n^2
//   First term  = potential energy in mode n's spring.
//   Second term = kinetic energy in mode n.
// Both omega and q/qdot live on latticeDef and modalState respectively.
//
// Bar color cycles hue from warm (low mode, slow) to cool (high mode, fast).
// Mode index labels (1-based) are drawn in the left margin.
function _drawModeEnergy() {
  // Lazy-initialise the 2D context once.
  if (!modeCtx) {
    const canvas = document.getElementById('mode-canvas');
    if (!canvas) return;
    modeCtx = canvas.getContext('2d');
  }
  const ctx = modeCtx;
  const cw  = ctx.canvas.width;
  const ch  = ctx.canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  const N = modalState.N;
  if (N === 0) return;

  // Compute mechanical energy in each mode.
  const E = new Array(N);
  let maxE = 0;
  for (let n = 0; n < N; n++) {
    const q  = modalState.q[n];
    const qd = modalState.qdot[n];
    const om = latticeDef.omega[n];
    E[n] = 0.5 * om * om * q * q + 0.5 * qd * qd;
    if (E[n] > maxE) maxE = E[n];
  }
  if (maxE < 1e-12) return;  // lattice at rest -- nothing to draw

  // Layout constants.
  const MARGIN  = 24;   // left margin for mode-number labels (px)
  const GAP     = 1;    // vertical gap between bars (px)
  const slotH   = (ch) / N;
  const barH    = Math.max(1, Math.floor(slotH) - GAP);
  const barArea = cw - MARGIN;

  ctx.font      = '8px monospace';
  ctx.textAlign = 'right';

  for (let n = 0; n < N; n++) {
    const norm = E[n] / maxE;
    const barW = norm * barArea;
    const y    = n * slotH;

    // Hue: mode 0 (lowest freq, warmest) --> mode N-1 (highest freq, coolest).
    // Range 30 deg (orange) to 220 deg (blue-violet).
    const hue = 30 + (n / Math.max(N - 1, 1)) * 190;
    ctx.fillStyle = `hsl(${hue}, 65%, 42%)`;
    ctx.fillRect(MARGIN, y, barW, barH);

    // Mode index label (1-based) in muted grey on the left.
    ctx.fillStyle = (norm > 0.05) ? '#666' : '#3a3a3a';
    ctx.fillText(n + 1, MARGIN - 3, y + barH - 1);
  }
}

// ---------------------------------------------------------------------------
// Window resize: keep canvas filling the window width
// ---------------------------------------------------------------------------
function windowResized() {
  const cw = min(windowWidth, 900);
  const ch = round(cw * 0.72);
  resizeCanvas(cw, ch);
  // Re-center camera after resize
  camera(0, -400, 500, 0, 0, 0, 0, 1, 0);
}
