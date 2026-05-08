/**
 * membrane-sketch.js
 *
 * p5.js sketch running in WEBGL mode on membrane.html.
 * Separate page from index.html and lattice.html; does not touch the other worlds.
 *
 * Responsibility:
 * - Own time (dt) and the physics loop
 * - Build MembraneDefinition and ModalState
 * - Render the membrane as a 3D wireframe mesh (Z displacement as visual signal)
 * - Provide orbitControl camera navigation
 * - Coordinate MembraneInteractionController (strike, hold, boundary toggle)
 * - Drive UI panels (physics sliders, tool buttons, readouts)
 *
 * Coordinate convention (WEBGL, +y is DOWN in p5):
 *   world_x = (physX - Lx/2) * MESH_SCALE    (+x = right)
 *   world_y = -(physY - Ly/2) * MESH_SCALE   (flip: physY=0 is bottom of screen)
 *   world_z = displacement * Z_SCALE          (+z = toward viewer at rest)
 *
 * MESH_SCALE is computed each frame from the canvas size and current Lx/Ly
 * so the membrane always fills roughly 80% of the smaller canvas dimension.
 *
 * Wireframe layout:
 *   The rendered mesh includes the boundary ring (at world_z=0) plus the
 *   Nx*Ny interior points. Rows iy = 0..Ny+1, columns ix = 0..Nx+1.
 *   (Ny+2) horizontal polylines + (Nx+2) vertical polylines.
 *   Each polyline has (Nx+2) or (Ny+2) vertices respectively.
 */

// --- Physics globals ---
let membraneDef;   // MembraneDefinition: domain, BCs, eigenpairs
let modalState;    // ModalState: modal coordinates q, qdot; steps time

// --- Interaction ---
let controller;    // MembraneInteractionController: strike, hold, boundary toggle

// --- Sound ---
let soundObserver;  // MembraneSoundObserver: modal additive synthesis, mono
let isMuted = false;

// --- Visual observer ---
let visualObserver;  // MembraneVisualObserver: wireframe mesh + boundary edge indicators

// --- Timing ---
const MEMBRANE_FR = 60;    // target frame rate (fps)
let   baseDt;              // 1 / MEMBRANE_FR -- base physics step per frame
let   timeScale  = 1.0;    // time scaling factor (1.0 = real-time)
let   isFrozen   = false;  // space key toggles freeze

// --- Helper mode state ---
// _lastAction: most recent named canvas interaction ('strike', 'hold', 'boundary').
// Exported in VP_STATE each frame so HelperMode.js can detect progression events.
// Reset to null one frame after being read (cleared in draw() after export).
let _lastAction   = null;
let _lastScenario = null;  // name of most recently applied preset (e.g. 'square')

// --- Rendering constants ---
// Z_SCALE: pixels of world-space z per unit physical displacement.
// Physical displacements are O(0.1-0.5) after a unit-strike; Z_SCALE=120
// gives 12-60 px of visible z-relief at typical camera distance.
const Z_SCALE = 120;

// AUDIO_SCALE: factor to map physics frequencies (Hz) to audible frequencies.
// f_audio = f_physics * AUDIO_SCALE.
// Default square: f_{1,1} = 3.11 Hz -> 3.11*80 = 249 Hz (B3). Not used in Step 1.
const AUDIO_SCALE = 80;

// --- Harmonic drive ---
// Applies a sinusoidal point force at the membrane center, projected onto all
// mode shapes, at the natural frequency of the selected mode. Builds up the
// resonant pattern over ~1/(2*zeta*omega_n) seconds of physics time.
let harmonicDrive = {
  enabled:  false,    // true when drive is active
  modeIdx:  0,        // index into membraneDef.omega -- which mode to drive at
  amplitude: 2.0,     // force amplitude (N, roughly -- units via mass-normalized Phi)
  phase:     0.0      // current drive phase (radians), accumulated in draw()
};

// --- Mode energy chart (2D canvas, drawn each frame) ---
let modeCanvasCtx = null;   // 2D context for the mode-energy bar chart

// --- Aspect ratio slider throttle ---
// Only call setAspectRatio every 4th frame during drag to keep 60fps.
// _arFrameCount counts frames since the last onAspectRatioInput call;
// _arPendingRatio holds the most recently received slider value.
let _arFrameCount   = 0;   // frames since last aspect ratio recompute
let _arPendingRatio = -1;  // -1 = no pending update

// Canvas dimensions (set in setup, used by controller).
let cw, ch;

// =============================================================================
// setup
// =============================================================================
function setup() {

  // --- Canvas ---
  // WEBGL mode: origin is at canvas CENTER. Right=+x, Down=+y, Toward-viewer=+z.
  // Subtract the sidebar width (#vp-tools) so the canvas fits beside the sidebar
  // in the flex row without overflowing. Falls back gracefully if sidebar is absent.
  const sidebarEl = document.getElementById('vp-tools');
  const sidebarW  = sidebarEl ? sidebarEl.offsetWidth : 0;
  cw = min(windowWidth - sidebarW, 900);
  ch = round(cw * 0.72);
  createCanvas(cw, ch, WEBGL).parent('canvas-container');
  // Set outer container width so the control panel matches the workspace.
  const outerEl = document.getElementById('vp-outer');
  if (outerEl) outerEl.style.width = (cw + sidebarW) + 'px';
  frameRate(MEMBRANE_FR);
  baseDt = 1 / MEMBRANE_FR;

  // --- Initial camera ---
  // Eye slightly above and in front, looking at origin.
  // orbitControl() in draw() lets the user override this by dragging.
  // The rotateX(-PI/6) in draw() provides a permanent forward tilt so
  // z-displacement (vibration) is always visible as surface relief.
  camera(0, -250, 450, 0, 0, 0, 0, 1, 0);

  // --- Build physics ---
  membraneDef = new MembraneDefinition({
    Lx:             1.0,     // membrane width (m) -- fixed, never changes
    Ly:             1.2,     // membrane height (m) -- initial Ly/Lx = 1.2
    tension:        97,      // surface tension T (N/m)
    sigma:          5,       // surface density (kg/m^2); c = sqrt(97/5) = 4.4 m/s
    Nx:             40,      // interior x-points
    Ny:             40,      // interior y-points
    modes:          30,      // retained modes
    boundaryLeft:   'free',
    boundaryRight:  'free',
    boundaryBottom: 'free',
    boundaryTop:    'free',
    damping: { base: 0.02, freqScale: 0.005 }
  });

  modalState     = new ModalState(membraneDef);
  controller     = new MembraneInteractionController(membraneDef, modalState, cw, ch, Z_SCALE);
  soundObserver  = new MembraneSoundObserver(membraneDef);
  visualObserver = new MembraneVisualObserver({ zScale: Z_SCALE });

  // --- Initial excitation ---
  // Gaussian velocity impulse at the membrane center. Excites many modes
  // simultaneously so there is energy to display immediately on load.
  controller.strikeAtCenter();

  // --- Register world config with Menu.js ---
  // vpBuildMenu creates the tab content including #mode-btn-row and #mode-canvas.
  // This must run BEFORE _buildModeButtons() and canvas context acquisition below.
  if (window.vpBuildMenu) {
    vpBuildMenu({
      world: 'membrane',
      tools: { hold: false },
      scenarios: [
        { label: 'square (1:1)',      onClick: function() { applyPreset('square');     } },
        { label: 'rectangle (1:1.5)', onClick: function() { applyPreset('rectangle');  } },
        { label: 'wide (1:0.6)',      onClick: function() { applyPreset('wide');       } },
        { label: 'corner strike',     onClick: function() { applyPreset('corner');     } },
        { label: 'two strikes',       onClick: function() { applyPreset('two_strike'); } },
      ]
    });
  }

  // --- Mode buttons and energy chart ---
  // Runs after vpBuildMenu() so #mode-btn-row and #mode-canvas exist in the DOM.
  _buildModeButtons();
  const mc = document.getElementById('mode-canvas');
  if (mc) modeCanvasCtx = mc.getContext('2d');
}

// =============================================================================
// draw -- called at MEMBRANE_FR fps
// =============================================================================
function draw() {

  // --- Handle pending aspect ratio slider update ---
  // Throttle: apply at most every 4th frame during drag to avoid dropped frames.
  _arFrameCount++;
  if (_arPendingRatio >= 0 && _arFrameCount >= 4) {
    membraneDef.setAspectRatio(_arPendingRatio);
    modalState.rebuild(membraneDef);
    _arPendingRatio = -1;
    _arFrameCount   = 0;
  }

  // --- Step physics ---
  const dt = isFrozen ? 0 : baseDt * timeScale;
  modalState.step(dt);

  // --- Apply hold constraint if in hold mode ---
  // Zero the held point AFTER step() so it stays at zero this frame.
  controller.holdStep();

  // --- Harmonic drive: sinusoidal point force at membrane center ---
  // Applied after step() as a velocity kick each frame: qdot[n] += f_n * dt.
  // f_n = Phi[k_center][n] * amplitude * sin(omega_drive * t)
  // Phi[k][n] projects the point force onto each modal coordinate.
  // Driving at omega_drive = omega[modeIdx] excites that mode at resonance;
  // other modes are excited proportionally to their shape value at center.
  // Skip if frozen (dt=0).
  if (harmonicDrive.enabled && !isFrozen) {
    const omega_drive = membraneDef.omega[harmonicDrive.modeIdx];
    harmonicDrive.phase += omega_drive * dt;            // advance phase by omega*dt
    const force_t = harmonicDrive.amplitude * Math.sin(harmonicDrive.phase);

    // Center grid point: column Nx/2, row Ny/2 (integer), flat index k_center.
    // This is the nearest interior point to physical center (Lx/2, Ly/2).
    const kx = Math.round((membraneDef.Nx - 1) / 2);
    const ky = Math.round((membraneDef.Ny - 1) / 2);
    const k_center = ky * membraneDef.Nx + kx;

    // Project point force onto modal coordinates via Phi[k_center][n].
    // membraneDef.Phi is stored as Phi[k][n] (Ntot rows, N columns).
    const N = modalState.N;
    for (let n = 0; n < N; n++) {
      modalState.qdot[n] += membraneDef.Phi[k_center][n] * force_t * dt;
    }
  }

  // --- Get current physical displacements ---
  // disp[k] = physical transverse displacement at interior spatial point k (m).
  const disp = modalState.getDisplacements();

  // --- Compute MESH_SCALE ---
  // Scale the physical domain to fill ~80% of the smaller canvas dimension.
  // MESH_SCALE = pixels per meter in world space.
  // cw/2 and ch/2 are the half-extents of the WEBGL canvas from center.
  const S = _meshScale();

  // --- WEBGL scene ---
  background(30);   // match body background (#1e1e1e)

  // --- Camera orbit ---
  // Only orbit when not holding a point (orbit + hold fight for the same gesture).
  if (controller.mode === 'none') {
    orbitControl(3, 3, 0.1);
  }

  // Base tilt: rotate model slightly toward viewer so z-displacement reads as
  // visible height. rotateX(-PI/6) = 30 degrees forward tilt.
  // This is a model rotation, not a camera rotation, so orbitControl still works.
  rotateX(-PI / 6);

  // --- Update hit-test projections ---
  // Must be called AFTER all WEBGL transforms and BEFORE any push()/pop().
  // Uses renderer.uModelMatrix, uViewMatrix, uPMatrix (not p5 screenX/Y, which
  // conflict with window.screenX/Y in this p5 build and are unavailable).
  // this._renderer refers to the p5 WEBGL renderer instance.
  controller.updateProjections(disp, S, this._renderer, cw, ch);
  // Update hover state after projections are current so hoverEdge reflects
  // the current camera orientation.
  controller.updateHover(mouseX, mouseY);

  // --- Update sound observer ---
  // Pass modal energies (per-mode kinetic + potential energy) to drive oscillator gains.
  // Also pass membraneDef so the observer can detect frequency changes (aspect ratio,
  // boundary toggles) and update oscillator pitches without rebuilding the audio graph.
  soundObserver.update(modalState.getModalEnergies(), membraneDef);

  // --- Draw surface mesh + boundary edge indicators ---
  // MembraneVisualObserver updates dispMax internally, then draws wireframe + edges.
  visualObserver.draw(disp, membraneDef, S, controller.hoverEdge);

  // --- Mode energy chart ---
  // Draws per-mode energy bars on the 2D canvas below the controls.
  _drawModeEnergy();

  // --- VP_STATE export for Menu.js poll loop ---
  // Menu.js reads this each animation frame to sync sidebar buttons and sliders.
  // currentTool: translate 'strike' to 'pointer' so Menu.js highlights ptr button.
  // zeta: wrap the base damping ratio in an array (same shape as MDOF world).
  // dampingSlope: 0 -- membrane does not use a per-mode slope.
  window.VP_STATE = {
    world:        'membrane',
    isDriveOn:    harmonicDrive.enabled,
    isMuted:      isMuted,
    isFrozen:     isFrozen,
    timeScale:    timeScale,
    zeta:         membraneDef ? [membraneDef._dampBase] : [0.02],
    dampingSlope: 0,
    currentTool:  controller ? (controller.tool === 'strike' ? 'pointer' : controller.tool) : 'pointer',
    // Membrane-specific fields for tab slider sync (via _membraneSyncUI)
    memAspect:    membraneDef ? (membraneDef.Ly / membraneDef.Lx) : 1.2,
    memTension:   membraneDef ? membraneDef.tension : 97,
    memDriveAmp:  harmonicDrive.amplitude,
    // Helper mode fields: last canvas action and most recently applied preset.
    lastAction:   _lastAction,
    lastScenario: _lastScenario
  };
  _lastAction = null;   // consume after one frame so HelperMode.js sees a pulse, not a hold
}

// =============================================================================
// _meshScale -- compute pixels per meter for the current domain dimensions.
//
// Scales to fill ~80% of the smaller canvas half-extent, considering both
// Lx and Ly so the membrane always fits on screen at any aspect ratio.
// =============================================================================
function _meshScale() {
  const def     = membraneDef;
  const halfW   = cw * 0.3;   // 60% of half-canvas width  (75% of previous 0.4)
  const halfH   = ch * 0.3;   // 60% of half-canvas height
  const scaleX  = halfW / (def.Lx / 2);   // pixels per meter in x
  const scaleY  = halfH / (def.Ly / 2);   // pixels per meter in y
  return Math.min(scaleX, scaleY);         // use the tighter constraint
}

// =============================================================================
// Keyboard shortcuts
// =============================================================================
function keyPressed() {
  // First gesture: start the AudioContext.
  soundObserver.ensureAudioGraph();

  if (key === ' ' || key === 'q' || key === 'Q') {
    // Space or Q: toggle freeze (pause/unpause physics)
    isFrozen = !isFrozen;
    return false;   // prevent page scroll on spacebar
  }

  if (key === 'r' || key === 'R') {
    // R: reset -- zero all modal coords, re-apply center strike, release drive
    modalState.rebuild(membraneDef);
    controller.strikeAtCenter();
    soundObserver.triggerStrike();
    visualObserver.dispMax = 0.3;   // reset color scale
    document.querySelectorAll('#mode-btn-row button').forEach(b => b.classList.remove('active'));
    if (harmonicDrive.enabled) {
      harmonicDrive.enabled = false;
      harmonicDrive.phase   = 0;
      const driveBtn = document.getElementById('drive-btn');
      if (driveBtn) { driveBtn.textContent = 'drive off'; driveBtn.classList.remove('active'); }
    }
  }

  if (key === 'm' || key === 'M') {
    // M: toggle mute
    onMuteToggle();
  }

  // Number keys 1-9: activate harmonic drive at that mode (0-based index n = key-1).
  // Sets the drive mode, resets phase, and enables drive.
  if (key >= '1' && key <= '9') {
    const n = parseInt(key) - 1;   // '1' -> mode 0, '9' -> mode 8
    if (n < membraneDef.N) {
      harmonicDrive.modeIdx = n;
      harmonicDrive.phase   = 0;
      harmonicDrive.enabled = true;
      // Sync drive UI: update select and button.
      const sel = document.getElementById('drive-mode-select');
      if (sel) sel.value = n;
      const btn = document.getElementById('drive-btn');
      if (btn) { btn.textContent = 'drive on'; btn.classList.add('active'); }
    }
  }

  // 0: turn off harmonic drive.
  if (key === '0') {
    harmonicDrive.enabled = false;
    harmonicDrive.phase   = 0;
    const btn = document.getElementById('drive-btn');
    if (btn) { btn.textContent = 'drive off'; btn.classList.remove('active'); }
  }
}

// =============================================================================
// Mouse event routing
// =============================================================================
function mousePressed() {
  // First gesture: start the AudioContext (browser autoplay policy).
  soundObserver.ensureAudioGraph();

  const S      = _meshScale();
  const action = controller.onMousePressed(mouseX, mouseY, S);
  if (action) _lastAction = action;   // captured for VP_STATE / HelperMode.js

  // Fire the transient knock sound on actual strikes (not hold or boundary toggle).
  if (action === 'strike') {
    soundObserver.triggerStrike();
  }

  // Sync BC indicator spans after any potential boundary toggle.
  // _syncBCIndicators is defined in the HTML inline script (global function).
  if (typeof _syncBCIndicators === 'function') _syncBCIndicators();

  // After a boundary toggle, mode shapes and frequencies change; rebuild buttons.
  if (action === 'boundary') {
    _buildModeButtons();
  }
}

function mouseReleased() {
  controller.onMouseReleased();
}

// =============================================================================
// onAspectRatioInput -- called by the aspect ratio slider's oninput event.
//
// Stores the new ratio as a pending update. draw() applies it at most
// every 4th frame so the 48k sin() evaluations in recompute() don't cause
// dropped frames during continuous slider drag.
//
// On slider release (onchange event), onAspectRatioChange() applies the
// exact final value immediately without throttling.
//
// @param {number} ratio -- Ly/Lx from the slider (0.5..2.0)
// =============================================================================
function onAspectRatioInput(ratio) {
  _arPendingRatio = ratio;
}

function onAspectRatioChange(ratio) {
  // Slider released: apply exact value immediately (unthrottled snap).
  _arPendingRatio = -1;
  _arFrameCount   = 0;
  membraneDef.setAspectRatio(ratio);
  modalState.rebuild(membraneDef);
  // Rebuild mode buttons (frequencies and ordering may have changed).
  _buildModeButtons();
  // Update the display readout.
  const el = document.getElementById('ar-val');
  if (el) el.textContent = ratio.toFixed(2);
}

// =============================================================================
// onTensionInput -- called by tension slider.
// @param {number} t -- new surface tension (N/m)
// =============================================================================
function onTensionInput(t) {
  membraneDef.setTension(t);
  modalState.rebuild(membraneDef);
}

// =============================================================================
// onDampingInput -- called by damping slider.
// @param {number} d -- new base damping ratio
// =============================================================================
function onDampingInput(d) {
  membraneDef.setDamping(d);
}

// =============================================================================
// onTimeScaleInput -- called by time scale slider.
// @param {number} s -- new time scale (0.02 = very slow, 1.0 = real-time)
// =============================================================================
function onTimeScaleInput(s) {
  timeScale = s;
}

// =============================================================================
// onMuteToggle -- called by the mute button in the HTML panel.
// Toggles isMuted and relays to soundObserver.
// =============================================================================
function onMuteToggle() {
  isMuted = !isMuted;
  soundObserver.setMuted(isMuted);
  // Update button label.
  const btn = document.getElementById('mute-btn');
  if (btn) {
    btn.textContent  = isMuted ? 'unmute' : 'mute';
    btn.className    = isMuted ? 'active'  : '';
  }
}

// =============================================================================
// onSetTool -- called by tool buttons in the HTML panel.
// @param {string} tool -- 'strike' or 'hold'
// =============================================================================
function onSetTool(tool) {
  controller.tool = tool;
  // Update button visual state in the panel.
  document.querySelectorAll('#tool-btn-row button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
}

// =============================================================================
// _buildModeButtons -- inject one button per retained mode into #mode-btn-row.
//
// Called once from setup(). Each button shows the (mx, my) index pair.
// Degenerate mode pairs (same omega to within 0.1%) are highlighted in amber.
//
// Clicking a button calls onModeButton(n), which excites that mode at amplitude
// 0.25 and lets it oscillate and damp freely.
// =============================================================================
function _buildModeButtons() {
  const row = document.getElementById('mode-btn-row');
  if (!row) return;

  row.innerHTML = '';   // clear any previous buttons

  const N      = membraneDef.N;
  const omega  = membraneDef.omega;
  const mi     = membraneDef.modeIndices;

  // --- Identify degenerate pairs ---
  // Two modes are degenerate if their frequencies differ by less than 0.1%.
  // Mark each mode index as degenerate (true/false).
  const isDegenerate = new Array(N).fill(false);
  for (let n = 0; n < N; n++) {
    for (let m = n + 1; m < N; m++) {
      // Relative frequency difference.
      const diff = Math.abs(omega[n] - omega[m]) / Math.max(omega[n], 1e-6);
      if (diff < 0.001) {
        isDegenerate[n] = true;
        isDegenerate[m] = true;
      }
    }
  }

  for (let n = 0; n < N; n++) {
    const btn = document.createElement('button');
    // Label: "(mx,my)" using mode index pair
    btn.textContent  = '(' + mi[n].mx + ',' + mi[n].my + ')';
    btn.dataset.mode = n;

    // Amber tint for degenerate modes (same omega as another mode).
    if (isDegenerate[n]) {
      btn.style.color       = '#ffd080';
      btn.style.borderColor = '#886020';
    }

    btn.onclick = () => onModeButton(n);
    row.appendChild(btn);
  }

  // Keep the harmonic drive mode selector in sync with the current mode list.
  _buildDriveSelect();

  // Rebuild the flyout mode grid (scenarios panel) to match the current mode list.
  // Pass labels and degeneracy flags so the flyout buttons stay in sync with the
  // physics-tab buttons whenever BC or aspect-ratio changes reorder the modes.
  if (window.vpRebuildMembraneModeButtons) {
    const labels = new Array(N);
    for (let n = 0; n < N; n++) {
      labels[n] = '(' + mi[n].mx + ',' + mi[n].my + ')';
    }
    window.vpRebuildMembraneModeButtons(labels, isDegenerate);
  }
}

// =============================================================================
// _buildDriveSelect -- populate the harmonic drive mode <select> element.
//
// Called from _buildModeButtons() whenever the mode list changes.
// Options show the (mx,my) label and omega value; value attribute = mode index.
// If the previously selected mode index is out of range, resets to mode 0.
// =============================================================================
function _buildDriveSelect() {
  const sel = document.getElementById('drive-mode-select');
  if (!sel) return;

  const N     = membraneDef.N;
  const omega = membraneDef.omega;
  const mi    = membraneDef.modeIndices;

  // Clamp harmonicDrive.modeIdx in case mode count changed after topology change.
  if (harmonicDrive.modeIdx >= N) harmonicDrive.modeIdx = 0;

  sel.innerHTML = '';   // clear old options

  for (let n = 0; n < N; n++) {
    const opt = document.createElement('option');
    opt.value       = n;
    // Show mode label and frequency (Hz, scaled to audio frequency for reference).
    const physHz    = omega[n] / (2 * Math.PI);
    const audioHz   = Math.round(physHz * 80);   // AUDIO_SCALE = 80
    opt.textContent = '(' + mi[n].mx + ',' + mi[n].my + ')  ' + audioHz + ' Hz';
    if (n === harmonicDrive.modeIdx) opt.selected = true;
    sel.appendChild(opt);
  }
}

// =============================================================================
// onColorToggle -- toggle the color overlay on the wireframe.
//
// Called by the color-checkbox in the Physics panel (Menu.js) and by the
// 'C' key shortcut (keyPressed). Syncs the checkbox's checked state so
// both entry points stay consistent.
// =============================================================================
function onColorToggle() {
  const isOn = visualObserver.toggleColor();
  // Sync the physics-panel checkbox (built by _buildMembranePhysicsExtras).
  const cb = document.getElementById('color-checkbox');
  if (cb) cb.checked = isOn;
}

// Expose so Menu.js can call window.onColorToggle() from the checkbox handler.
window.onColorToggle = onColorToggle;

// =============================================================================
// onDriveToggle -- enable or disable harmonic drive.
//
// Enabling: resets drive phase to 0 and releases any mode isolation (they conflict:
// isolation forcibly sets modal coords each frame, which would mask the drive).
// Disabling: stops the force; natural decay resumes.
// =============================================================================
function onDriveToggle() {
  harmonicDrive.enabled = !harmonicDrive.enabled;

  if (harmonicDrive.enabled) {
    // Reset phase so the drive starts cleanly from sin(0)=0 (no DC step).
    harmonicDrive.phase = 0;
  }

  const btn = document.getElementById('drive-btn');
  if (btn) {
    btn.textContent = harmonicDrive.enabled ? 'drive on' : 'drive off';
    btn.classList.toggle('active', harmonicDrive.enabled);
  }
}

// window.vpToggleDrive -- public alias for Menu.js contextual button.
// The ctx-drive button in the sidebar calls this each click.
window.vpToggleDrive = onDriveToggle;

// window.vpLaunchMembraneMode -- called by the flyout mode-shape grid buttons.
// Excites mode n at amplitude 0.25 and lets physics damp it freely.
window.vpLaunchMembraneMode = onModeButton;

// ---------------------------------------------------------------------------
// window.vpXxx -- public aliases for Menu.js universal controls.
// The sidebar's universal sliders (speed, damp, slope) call these.
// ---------------------------------------------------------------------------

// vpSetTimeScale -- update simulation speed.
window.vpSetTimeScale = function(v) {
  timeScale = Math.max(0.01, v);
};

// vpSetDamping -- update base modal damping ratio.
window.vpSetDamping = function(v) {
  onDampingInput(v);
  // No separate readout sync needed: the poll loop's _syncSliderIfIdle will
  // update slider-zeta next frame via VP_STATE.zeta[0] = membraneDef._dampBase.
};

// vpSetDampingSlope -- no-op for membrane (uses freqScale, not a user-facing slope).
window.vpSetDampingSlope = function() {};

// vpZeroState -- clear all modal displacement and velocity.
window.vpZeroState = function() {
  if (!membraneDef || !modalState) return;
  const Ntot = membraneDef.spatialSize();
  const z    = new Array(Ntot).fill(0);
  modalState.setPhysicalState(z, z);
};

// vpToggleMute -- toggle audio mute.
window.vpToggleMute = onMuteToggle;

// vpSetTool -- switch interaction tool. Menu.js calls with 'pointer' or 'hold'.
// 'pointer' maps to membrane's 'strike' tool.
window.vpSetTool = function(t) {
  onSetTool(t === 'pointer' ? 'strike' : t);
};

// =============================================================================
// onHarmonicModeChange -- change which mode the drive targets.
//
// @param {number} n -- mode index (0-based, from the <select> value)
// =============================================================================
function onHarmonicModeChange(n) {
  harmonicDrive.modeIdx = n;
  // Reset phase when switching modes so the new frequency starts from zero crossing.
  harmonicDrive.phase = 0;
}

// =============================================================================
// onHarmonicAmpChange -- set the drive force amplitude from the slider.
//
// @param {number} a -- new amplitude (roughly Newtons via mass-normalized Phi)
// =============================================================================
function onHarmonicAmpChange(a) {
  harmonicDrive.amplitude = a;
}

// =============================================================================
// onModeButton -- excite a single mode and let it oscillate and damp freely.
//
// Sets modal coordinate n to amplitude 0.25 (m) and all others to zero,
// with zero velocities, then releases control. The mode rings down naturally
// at its own frequency and damping ratio -- no sustained re-injection.
//
// Clicking repeatedly re-excites the same mode (resets the amplitude).
// Degenerate pairs can be compared by clicking each in turn.
//
// @param {number} n -- 0-based mode index
// =============================================================================
function onModeButton(n) {
  // Set modal coordinates: mode n at amplitude 0.25, all others zero.
  // qdot = 0 so the mode starts at peak displacement (cosine initial condition).
  for (let i = 0; i < modalState.N; i++) {
    modalState.q[i]    = (i === n) ? 0.25 : 0;
    modalState.qdot[i] = 0;
  }

  // Turn off harmonic drive so the selected mode shape can damp out freely
  // without the drive continuously re-exciting it.
  if (harmonicDrive.enabled) {
    harmonicDrive.enabled = false;
    harmonicDrive.phase   = 0;
    const driveBtn = document.getElementById('drive-btn');
    if (driveBtn) { driveBtn.textContent = 'drive off'; driveBtn.classList.remove('active'); }
  }

  // Highlight the clicked button; clear all others.
  document.querySelectorAll('#mode-btn-row button').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.mode) === n);
  });
}

// =============================================================================
// _drawModeEnergy -- draw the mode energy bar chart on the 2D canvas.
//
// One horizontal bar per mode. Bar width = energy / maxEnergy * chartWidth.
// Color: normal modes = blue-gray; degenerate modes = amber.
// =============================================================================
function _drawModeEnergy() {
  if (!modeCanvasCtx) return;

  const ctx      = modeCanvasCtx;
  const mc       = document.getElementById('mode-canvas');
  const W        = mc.width;
  const H        = mc.height;
  const N        = membraneDef.N;
  const omega    = membraneDef.omega;
  const mi       = membraneDef.modeIndices;
  const barH     = Math.max(1, Math.floor(H / N) - 1);  // bar height in pixels
  const maxBarW  = W - 80;  // leave space for label on right

  // Get current modal energies.
  const energies = modalState.getModalEnergies();

  // Find peak energy for normalization.
  let maxE = 0;
  for (let n = 0; n < N; n++) if (energies[n] > maxE) maxE = energies[n];
  if (maxE < 1e-10) maxE = 1e-10;

  // --- Degenerate detection (same as _buildModeButtons) ---
  const isDeg = new Array(N).fill(false);
  for (let n = 0; n < N; n++) {
    for (let m = n + 1; m < N; m++) {
      if (Math.abs(omega[n] - omega[m]) / Math.max(omega[n], 1e-6) < 0.001) {
        isDeg[n] = true;
        isDeg[m] = true;
      }
    }
  }

  // Clear chart.
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, W, H);

  for (let n = 0; n < N; n++) {
    const y     = n * (barH + 1);   // top of bar n
    const normE = energies[n] / maxE;
    const barW  = Math.round(normE * maxBarW);

    // Degenerate modes: amber. Others: blue-gray.
    const barColor = isDeg[n] ? '#996020' : '#2a4a6a';

    ctx.fillStyle = barColor;
    ctx.fillRect(0, y, barW, barH);

    // Label: "(mx,my)" on the right side.
    ctx.fillStyle = isDeg[n] ? '#ffd080' : '#445566';
    ctx.font      = '9px monospace';
    ctx.fillText('(' + mi[n].mx + ',' + mi[n].my + ')', maxBarW + 4, y + barH - 1);
  }
}

// =============================================================================
// applyPreset -- apply a named scenario.
//
// Presets configure aspect ratio, damping, and initial excitation.
// After applying: rebuild modal state, re-strike, sync UI sliders.
//
// @param {string} name -- preset name
// =============================================================================
function applyPreset(name) {
  _lastScenario = name;   // captured for VP_STATE / HelperMode.js
  // Release harmonic drive before applying preset.
  document.querySelectorAll('#mode-btn-row button').forEach(b => b.classList.remove('active'));
  if (harmonicDrive.enabled) {
    harmonicDrive.enabled = false;
    harmonicDrive.phase   = 0;
    const driveBtn = document.getElementById('drive-btn');
    if (driveBtn) { driveBtn.textContent = 'drive off'; driveBtn.classList.remove('active'); }
  }

  const PRESETS = {
    // square (1:1): default parameters, center strike.
    // Degenerate mode pairs visible: (2,1)=(1,2), (3,1)=(1,3), etc.
    'square': {
      ratio: 1.0, tension: 97, damping: 0.02,
      strikes: [{ relX: 0.5, relY: 0.5 }]
    },
    // rectangle (1:1.5): Ly/Lx = 1.5.
    // Breaks square degeneracies: omega_{2,1} != omega_{1,2}.
    'rectangle': {
      ratio: 1.5, tension: 97, damping: 0.02,
      strikes: [{ relX: 0.5, relY: 0.5 }]
    },
    // wide (1:0.6): Ly/Lx = 0.6. Wide rectangle, high x-frequencies.
    'wide': {
      ratio: 0.6, tension: 97, damping: 0.02,
      strikes: [{ relX: 0.5, relY: 0.5 }]
    },
    // corner strike: excites antisymmetric modes (even-odd and odd-even pairs).
    // A center strike misses these; a corner hit excites everything.
    'corner': {
      ratio: 1.0, tension: 97, damping: 0.03,
      strikes: [{ relX: 0.2, relY: 0.2 }]
    },
    // two strikes: simultaneous impulses at 1/4 and 3/4 width.
    // Creates interference between left-half and right-half modes.
    'two_strike': {
      ratio: 1.0, tension: 97, damping: 0.02,
      strikes: [{ relX: 0.25, relY: 0.5 }, { relX: 0.75, relY: 0.5 }]
    }
  };

  const p = PRESETS[name];
  if (!p) return;

  // Apply physical parameters.
  membraneDef.setAspectRatio(p.ratio);
  membraneDef.setTension(p.tension);
  membraneDef.setDamping(p.damping);
  modalState.rebuild(membraneDef);

  // Reset displacement to zero before strikes.
  const Ntot = membraneDef.spatialSize();
  const zeroX = new Array(Ntot).fill(0);
  const zeroV = new Array(Ntot).fill(0);
  modalState.setPhysicalState(zeroX, zeroV);

  // Apply each strike in the preset.
  for (const s of p.strikes) {
    const physX = s.relX * membraneDef.Lx;
    const physY = s.relY * membraneDef.Ly;
    controller._strikeAt(physX, physY);
  }

  // Sound: rebuild frequencies and fire a knock for each strike.
  for (let i = 0; i < p.strikes.length; i++) {
    soundObserver.triggerStrike();
  }

  // Reset visual state.
  visualObserver.dispMax = 0.3;

  // Sync UI sliders to match preset values.
  _syncPresetUI(p.ratio, p.tension, p.damping);

  // Rebuild mode buttons (frequencies change with aspect ratio).
  _buildModeButtons();
}

// =============================================================================
// _syncPresetUI -- update slider positions and value readouts after applyPreset.
//
// @param {number} ratio   -- aspect ratio Ly/Lx (for the aspect slider)
// @param {number} tension -- tension T (N/m)
// @param {number} damping -- base damping ratio
// =============================================================================
function _syncPresetUI(ratio, tension, damping) {
  // Aspect ratio: new shared-skeleton layout uses slider-mem-aspect / val-mem-aspect.
  const arSlider = document.getElementById('slider-mem-aspect');
  const arVal    = document.getElementById('val-mem-aspect');
  if (arSlider) arSlider.value   = ratio;
  if (arVal)    arVal.textContent = ratio.toFixed(2);

  // Tension: new layout uses slider-mem-tension / val-mem-tension.
  const tSlider = document.getElementById('slider-mem-tension');
  const tVal    = document.getElementById('val-mem-tension');
  if (tSlider) tSlider.value   = tension;
  if (tVal)    tVal.textContent = Math.round(tension);

  // Damping: synced via universal slider-zeta / val-zeta (replaces bespoke sl-damping).
  const zetaSlider = document.getElementById('slider-zeta');
  const zetaVal    = document.getElementById('val-zeta');
  if (zetaSlider) zetaSlider.value    = damping;
  if (zetaVal)    zetaVal.textContent = damping.toFixed(3);
}
