/**
 * Menu.js  
 *
 * Responsibility:
 *   Build the tool sidebar (#vp-tools) and the control panel tab shell
 *   (#vp-controls). Wire button actions to window.vpXxx() globals that
 *   sketch.js defines. Manage the accessibility mode toggle.
 *   Populate the Physics tab with universal controls (speed, damp, slope).
 *   Run a poll() loop that syncs tool highlights, mute state, and slider
 *   readouts from window.VP_STATE each animation frame.
 *
 * Does NOT (yet):
 *   - Show a scenarios flyout (Step 3)
 *   - Populate Geometry or Sound tabs (Step 3+)
 *
 * Called by:
 *   window.vpBuildMenu(config)  -- each world's setup() calls this to
 *                                   pass world-specific config; in Step 1
 *                                   the config is not yet used for content.
 *   DOMContentLoaded            -- auto-init so the sidebar appears immediately.
 *
 * Data flow (read-only from Menu.js perspective):
 *   window.vpSetTool(name)      -- changes the active tool in sketch.js
 *   window.vpZeroState()        -- zeroes all modal coordinates
 *   window.vpToggleMute()       -- toggles sound mute
 *   window.VP_STATE             -- frame-by-frame state snapshot (Step 2+)
 *
 * Tool buttons:
 *   tool-pointer   Pointer    vpSetTool('pointer')    active by default
 *   tool-hold      Hold       vpSetTool('hold')       toggle
 *   tool-zero      Zero       vpZeroState()           momentary flash
 *   tool-mute      Mute       vpToggleMute()          toggle (muted class)
 *   tool-scenes    Scenes     (flyout, Step 3)        no-op for now
 *
 * Tab buttons: Geometry | Physics | Sound
 *   Click tab to open. Click again to close (all-hidden = panel collapsed).
 *   Default on load: Physics tab open.
 */

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// Reference to the world config passed via vpBuildMenu().
// Null until the sketch calls vpBuildMenu().
let _worldConfig = null;

// The button element currently highlighted as the active tool.
// Pointer is activated on init; poll loop (Step 2) will keep it in sync.
let _activeToolBtn = null;

// Whether mute is locally tracked (before poll loop in Step 2 takes over).
let _muteLocal = false;

// The currently open tab ID string ('geometry', 'physics', 'sound') or null.
let _activeTab = null;

// Topology change detection (Step 3).
// When these differ from the matching VP_STATE fields, the DOM sections rebuild.
let _prevNMasses = -1;  // last rendered mass count; -1 = never built
let _prevNFree   = -1;  // last rendered free-mode count; -1 = never built

// Contextual button state (Step 4).
// Tracks whether the strum tool has been auto-selected for the current strings
// world session. Resets to false each time the strings world is exited so
// the auto-select fires again on the next entry.
let _strumAutoSelected = false;

// Whether the scenarios flyout was opened by a click (pinned = true) vs
// hover alone (pinned = false).  A pinned flyout ignores mouseleave so it
// stays open until the user clicks the Scenarios button a second time.
let _flyoutPinned = false;

// Previous modal-forcing state: used in _syncContextualButtons to detect
// the off --> on transition and auto-enable the modal energy overlay.
let _prevForcingActive = false;

// ---------------------------------------------------------------------------
// _buildSidebar -- inject five tool buttons into #vp-tools.
//
// Buttons are built as <button> elements with class="vp-tool-btn".
// Each gets id, aria-label, and title attributes for accessibility.
// Click handlers call the appropriate window.vpXxx() function.
// ---------------------------------------------------------------------------
function _buildSidebar() {
  const container = document.getElementById('vp-tools');
  if (!container) return;

  container.innerHTML = '';  // clear any existing content

  // Button definitions: [ id, label (short display text), aria-label, clickHandler ]
  // 'pointer' and 'hold' are mode toggles; 'zero' is momentary; 'mute' is toggle.
  // 'scenes' opens a flyout (Step 3 -- no-op here).
  const defs = [
    {
      id:        'tool-pointer',
      label:     'MOVE',
      ariaLabel: 'Pointer tool -- default interaction mode',
      onClick:   _clickPointer
    },
    {
      id:        'tool-hold',
      label:     'HOLD',
      ariaLabel: 'Hold tool -- pin a mass in place',
      onClick:   _clickHold
    },
    {
      id:        'tool-zero',
      label:     'ZERO',
      ariaLabel: 'Zero -- clear all displacement and velocity',
      onClick:   _clickZero
    },
    {
      id:        'tool-mute',
      label:     'MUTE',
      ariaLabel: 'Toggle mute',
      onClick:   _clickMute
    },
    {
      id:        'tool-scenes',
      label:     'SCENE',
      ariaLabel: 'Scenarios -- load a preset configuration',
      onClick:   _clickScenes
    }
  ];

  for (const def of defs) {
    const btn = document.createElement('button');
    btn.id          = def.id;
    btn.className   = 'vp-tool-btn';
    btn.textContent = def.label;
    btn.setAttribute('aria-label', def.ariaLabel);
    btn.setAttribute('title', def.ariaLabel);  // visible tooltip always on
    btn.addEventListener('click', def.onClick);
    container.appendChild(btn);
  }

  // aria-expanded starts false on the scenes button; _clickScenes() updates it.
  const scenesBtn = document.getElementById('tool-scenes');
  if (scenesBtn) scenesBtn.setAttribute('aria-expanded', 'false');

  // Hover persistence: mouseenter on the Scenarios button opens the flyout;
  // mouseleave on the whole toolbar container closes it.  Both the button and
  // the flyout are children of `container` (#vp-tools), so moving the mouse
  // from the button into the flyout panel does not fire a mouseleave on the
  // container -- the flyout stays open as long as the cursor is inside either.
  if (scenesBtn) {
    scenesBtn.addEventListener('mouseenter', () => {
      flyout.style.top = scenesBtn.offsetTop + 'px';
      flyout.classList.add('open');
      scenesBtn.setAttribute('aria-expanded', 'true');
    });
  }
  container.addEventListener('mouseleave', () => {
    // Only close on hover-out if the flyout was not pinned open by a click.
    if (_flyoutPinned) return;
    flyout.classList.remove('open');
    if (scenesBtn) scenesBtn.setAttribute('aria-expanded', 'false');
  });

  // Activate the pointer button by default.
  _setActiveToolBtn(document.getElementById('tool-pointer'));

  // Contextual button zone: populated dynamically by _syncContextualButtons()
  // each poll frame based on VP_STATE.world and other conditions.
  // Sits below the 5 static buttons; separator only renders when non-empty.
  const ctxZone = document.createElement('div');
  ctxZone.id = 'vp-ctx-btns';
  container.appendChild(ctxZone);

  // Forcing frequency readout: shown below the button zone when modal forcing
  // is active (F key).  Updated each poll frame by _syncContextualButtons().
  // Also acts as a drag control: drag up to raise frequency, down to lower it.
  const forcingReadout = document.createElement('div');
  forcingReadout.id = 'vp-forcing-readout';
  forcingReadout.title = 'Drag up/down to change forcing frequency';
  container.appendChild(forcingReadout);

  // Drag state: set on pointerdown, cleared on pointerup/cancel.
  // startY and startHz capture the baseline so the drag is absolute
  // (not cumulative), preventing drift on repeated small drags.
  let _forcingDrag = null;

  // Hz change per pixel dragged.  At 0.02 Hz/px the full 0.1-5.0 range
  // spans ~245px of vertical travel -- a comfortable sweep.
  const HZ_PER_PX = 0.02;
  const HZ_MIN    = 0.1;
  const HZ_MAX    = 5.0;

  forcingReadout.addEventListener('pointerdown', (e) => {
    if (!window.VP_STATE || !window.VP_STATE.modalForcingActive) return;
    e.preventDefault();
    forcingReadout.setPointerCapture(e.pointerId);
    _forcingDrag = { startY: e.clientY, startHz: window.VP_STATE.modalForcingHz };
  });

  forcingReadout.addEventListener('pointermove', (e) => {
    if (!_forcingDrag) return;
    // Upward drag (negative dy in screen coords) increases frequency.
    const dy  = _forcingDrag.startY - e.clientY;
    const hz  = Math.min(HZ_MAX, Math.max(HZ_MIN, _forcingDrag.startHz + dy * HZ_PER_PX));
    if (window.vpSetModalForcingHz) window.vpSetModalForcingHz(hz);
  });

  forcingReadout.addEventListener('pointerup',     () => { _forcingDrag = null; });
  forcingReadout.addEventListener('pointercancel', () => { _forcingDrag = null; });

  // Force amplitude readout: same style and drag behavior as the Hz readout.
  // Drag up increases amplitude, drag down decreases.  Range 0.1 -- 5.0 N.
  const ampReadout = document.createElement('div');
  ampReadout.id    = 'vp-forcing-amp-readout';
  ampReadout.title = 'Drag up/down to change forcing amplitude';
  container.appendChild(ampReadout);

  let _ampDrag = null;
  const AMP_PER_PX = 0.02;
  const AMP_MIN    = 0.1;
  const AMP_MAX    = 5.0;

  ampReadout.addEventListener('pointerdown', (e) => {
    if (!window.VP_STATE || !window.VP_STATE.modalForcingActive) return;
    e.preventDefault();
    ampReadout.setPointerCapture(e.pointerId);
    _ampDrag = { startY: e.clientY, startAmp: window.VP_STATE.modalForcingAmp };
  });

  ampReadout.addEventListener('pointermove', (e) => {
    if (!_ampDrag) return;
    const dy  = _ampDrag.startY - e.clientY;
    const amp = Math.min(AMP_MAX, Math.max(AMP_MIN, _ampDrag.startAmp + dy * AMP_PER_PX));
    if (window.vpSetForcingAmp) window.vpSetForcingAmp(amp);
  });

  ampReadout.addEventListener('pointerup',     () => { _ampDrag = null; });
  ampReadout.addEventListener('pointercancel', () => { _ampDrag = null; });

  // Build the (hidden) flyout div for scenarios (Step 3 will populate it).
  const flyout = document.createElement('div');
  flyout.id = 'vp-scenes-flyout';
  container.appendChild(flyout);

  // Click-outside closes the flyout.
  document.addEventListener('click', (e) => {
    if (!flyout.classList.contains('open')) return;
    if (!container.contains(e.target)) {
      flyout.classList.remove('open');
      _flyoutPinned = false;
      const sb = document.getElementById('tool-scenes');
      if (sb) sb.setAttribute('aria-expanded', 'false');
    }
  });
}

// ---------------------------------------------------------------------------
// _buildTabShell -- inject three tab buttons into #vp-tab-bar.
//
// Tab content divs (#vp-tab-geometry, #vp-tab-physics, #vp-tab-sound) are
// already in the HTML. This function only builds the clickable tab headers.
// ---------------------------------------------------------------------------
function _buildTabShell() {
  const tabBar = document.getElementById('vp-tab-bar');
  if (!tabBar) return;

  tabBar.innerHTML = '';

  const tabs = [
    { key: 'geometry', label: 'Geometry' },
    { key: 'physics',  label: 'Physics'  },
    { key: 'sound',    label: 'Sound'    }
  ];

  for (const tab of tabs) {
    const btn = document.createElement('button');
    btn.className   = 'vp-tab';
    btn.textContent = tab.label;
    btn.dataset.tab = tab.key;
    btn.setAttribute('aria-label', tab.label + ' tab');
    btn.setAttribute('tabindex', '0');
    btn.addEventListener('click', () => _clickTab(tab.key));
    tabBar.appendChild(btn);
  }

  // Tabs start collapsed. User clicks a tab header to open it.
  // _closeAllTabs() is a no-op here since nothing is open yet, but calling
  // _activeTab = null explicitly keeps module state consistent.
  _activeTab = null;
}

// ---------------------------------------------------------------------------
// _wireA11yToggle -- attach click handler to #btn-accessible in the nav bar.
//
// Toggling body.vp-a11y drives all size changes via CSS rules in menu.css.
// When a11y mode is on, aria-label values are copied to title attributes so
// they appear as native browser tooltips on hover. When off, titles are cleared.
// ---------------------------------------------------------------------------
function _wireA11yToggle() {
  const btn = document.getElementById('btn-accessible');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const isOn = document.body.classList.toggle('vp-a11y');
    _syncA11yTitles(isOn);
  });
}

// _syncA11yTitles -- copy aria-label -> title (on) or remove title (off)
// for all interactive elements that Menu.js manages.
function _syncA11yTitles(isOn) {
  const els = document.querySelectorAll(
    '.vp-tool-btn, .vp-tab, .vp-scene-btn, #btn-accessible'
  );
  for (const el of els) {
    if (isOn) {
      const label = el.getAttribute('aria-label');
      if (label) el.setAttribute('title', label);
    } else {
      // In non-a11y mode, keep title (browsers show native tooltips on hover).
      // This is intentional: titles are always set so tooltips work everywhere.
    }
  }
}

// ---------------------------------------------------------------------------
// Tool button click handlers
// ---------------------------------------------------------------------------

// _setActiveToolBtn -- deactivate the previous active button, activate the new one.
// Used for toggle-mode tools (pointer, hold).
function _setActiveToolBtn(btn) {
  if (_activeToolBtn) _activeToolBtn.classList.remove('active');
  _activeToolBtn = btn;
  if (_activeToolBtn) _activeToolBtn.classList.add('active');
}

function _clickPointer() {
  _setActiveToolBtn(this);
  if (window.vpSetTool) window.vpSetTool('pointer');
}

function _clickHold() {
  // If Hold is aria-disabled (not available in this world), do nothing.
  if (this.getAttribute('aria-disabled') === 'true') return;
  _setActiveToolBtn(this);
  if (window.vpSetTool) window.vpSetTool('hold');
}

function _clickZero() {
  // Momentary action: brief visual flash, then call vpZeroState().
  const btn = this;
  btn.classList.add('flash');
  setTimeout(() => btn.classList.remove('flash'), 120);
  if (window.vpZeroState) window.vpZeroState();
}

function _clickMute() {
  _muteLocal = !_muteLocal;
  this.classList.toggle('muted', _muteLocal);
  if (window.vpToggleMute) window.vpToggleMute();
}

function _clickScenes() {
  const flyout = document.getElementById('vp-scenes-flyout');
  if (!flyout) return;
  const isOpen = flyout.classList.contains('open');
  if (isOpen && _flyoutPinned) {
    // Second click: unpin and close.
    flyout.classList.remove('open');
    _flyoutPinned = false;
    const btn = document.getElementById('tool-scenes');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  } else {
    // First click (or click while hover-open): pin and open.
    flyout.style.top = this.offsetTop + 'px';
    flyout.classList.add('open');
    _flyoutPinned = true;
    const btn = document.getElementById('tool-scenes');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    // Move focus to the first scenario button so keyboard users can navigate.
    const first = flyout.querySelector('.vp-scene-btn');
    if (first) first.focus();
  }
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

// _openTab -- show the given tab's content, mark its header active.
// Also hides all other tabs.
//
// @param {string} key -- 'geometry', 'physics', or 'sound'
function _openTab(key) {
  const allTabs    = document.querySelectorAll('.vp-tab');
  const allContent = document.querySelectorAll('.vp-tab-content');

  for (const t of allTabs) {
    t.classList.toggle('active', t.dataset.tab === key);
  }
  for (const c of allContent) {
    // Content div IDs are: vp-tab-geometry, vp-tab-physics, vp-tab-sound.
    const match = c.id === 'vp-tab-' + key;
    c.classList.toggle('active', match);
  }

  _activeTab = key;
}

// _closeAllTabs -- hide all tab content (panel collapsed).
function _closeAllTabs() {
  document.querySelectorAll('.vp-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.vp-tab-content').forEach(c => c.classList.remove('active'));
  _activeTab = null;
}

// _clickTab -- called when a tab header is clicked.
// Clicking the already-open tab collapses the panel.
function _clickTab(key) {
  if (_activeTab === key) {
    _closeAllTabs();
  } else {
    _openTab(key);
  }
}

// ---------------------------------------------------------------------------
// _makeSliderRow -- build a <div class="vp-ctrl-row"> with label, range, value.
//
// Attaches idle-tracking listeners so _syncSliderIfIdle() does not overwrite
// the slider while the user is actively dragging it.
// Also wires the 'input' event to call onChange(value) live.
//
// @param {Object} cfg
//   cfg.id       {string}   -- id for the <input>; val id = id.replace('slider-','val-')
//   cfg.label    {string}   -- short label text (e.g. 'speed')
//   cfg.min      {number}
//   cfg.max      {number}
//   cfg.step     {number}
//   cfg.value    {number}   -- initial value
//   cfg.fmtFn    {function} -- (number) -> string for the readout
//   cfg.onChange {function} -- (number) -> called on every 'input' event
// ---------------------------------------------------------------------------
function _makeSliderRow(cfg) {
  const row = document.createElement('div');
  row.className = 'vp-ctrl-row';

  const lbl = document.createElement('span');
  lbl.className   = 'lbl';
  lbl.textContent = cfg.label;

  const slider = document.createElement('input');
  slider.type  = 'range';
  slider.id    = cfg.id;
  slider.min   = cfg.min;
  slider.max   = cfg.max;
  slider.step  = cfg.step;
  slider.value = cfg.value;
  slider.setAttribute('aria-label', cfg.label + ' slider');

  const valEl = document.createElement('span');
  valEl.className   = 'val';
  valEl.id          = cfg.id.replace('slider-', 'val-');
  valEl.textContent = cfg.fmtFn(cfg.value);

  // Idle tracking: poll loop skips this slider while _isDragging is true.
  slider._isDragging = false;
  slider.addEventListener('pointerdown', () => { slider._isDragging = true;  });
  slider.addEventListener('pointerup',   () => { slider._isDragging = false; });
  slider.addEventListener('blur',        () => { slider._isDragging = false; });

  // Live update: update readout and call the physics function on every drag tick.
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    valEl.textContent = cfg.fmtFn(v);
    if (cfg.onChange) cfg.onChange(v);
  });

  row.appendChild(lbl);
  row.appendChild(slider);
  row.appendChild(valEl);
  return row;
}

// ---------------------------------------------------------------------------
// _buildPhysicsTab -- populate #vp-tab-physics with universal controls.
//
// Three sliders always present for every world:
//   speed  -- simulation time scale.  Wires to vpSetTimeScale().
//   damp   -- base modal damping ratio zeta_0.  Wires to vpSetDamping().
//   slope  -- per-mode damping increment. zeta_n = zeta_0 + slope*(n/(N-1)).
//             Wires to vpSetDampingSlope().
//
// Called once from _init(). World-specific controls are added by Step 3
// via vpBuildMenu(config) after setup() runs.
// ---------------------------------------------------------------------------
function _buildPhysicsTab() {
  const panel = document.getElementById('vp-tab-physics');
  if (!panel) return;

  panel.innerHTML = '';  // clear placeholder content

  // Section header
  const hdr = document.createElement('div');
  hdr.className   = 'vp-ctrl-hdr';
  hdr.textContent = 'universal';
  panel.appendChild(hdr);

  // Speed slider: 0.02x (very slow, for inspection) to 2.0x (double speed).
  panel.appendChild(_makeSliderRow({
    id:       'slider-speed',
    label:    'speed',
    min:      0.02,
    max:      2.0,
    step:     0.01,
    value:    1.0,
    fmtFn:    v => v.toFixed(2) + 'x',
    onChange: v => { if (window.vpSetTimeScale) window.vpSetTimeScale(v); }
  }));

  // Damping slider: base modal damping ratio zeta_0.
  panel.appendChild(_makeSliderRow({
    id:       'slider-zeta',
    label:    'damp',
    min:      0.001,
    max:      0.5,
    step:     0.001,
    value:    0.05,
    fmtFn:    v => v.toFixed(3),
    onChange: v => { if (window.vpSetDamping) window.vpSetDamping(v); }
  }));

  // Slope slider: per-mode damping increment.
  panel.appendChild(_makeSliderRow({
    id:       'slider-slope-zeta',
    label:    'slope',
    min:      0,
    max:      2.0,
    step:     0.01,
    value:    0,
    fmtFn:    v => v.toFixed(2),
    onChange: v => { if (window.vpSetDampingSlope) window.vpSetDampingSlope(v); }
  }));
}

// ---------------------------------------------------------------------------
// Poll loop helpers
// ---------------------------------------------------------------------------

// _syncSliderIfIdle -- update a slider's value and readout from the physics
// state, but only when the user is not actively dragging the slider.
// Prevents jitter: if the user is dragging, their input wins over VP_STATE.
//
// @param {string}   id    -- slider element id (e.g. 'slider-speed')
// @param {number}   value -- new value from VP_STATE
// @param {function} fmtFn -- (number) -> string for the readout span
function _syncSliderIfIdle(id, value, fmtFn) {
  const el = document.getElementById(id);
  if (!el || el._isDragging) return;
  el.value = value;
  const valEl = document.getElementById(id.replace('slider-', 'val-'));
  if (valEl) valEl.textContent = fmtFn(value);
}

// _syncToolHighlights -- mark the correct sidebar button as active based on
// the current tool reported in VP_STATE.
//
// Only pointer and hold are mode-type tool buttons with persistent active state.
// Zero, mute, and scenes are action/toggle buttons handled separately.
//
// @param {string} currentTool -- value from VP_STATE.currentTool
function _syncToolHighlights(currentTool) {
  // Map sketch tool names to sidebar button IDs.
  const map = {
    'pointer':   'tool-pointer',
    'hold':      'tool-hold',
    // 'delete' and 'kinematic' have no dedicated sidebar button yet.
  };
  const targetId = map[currentTool] || null;

  const modeBtnIds = ['tool-pointer', 'tool-hold'];
  for (const id of modeBtnIds) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', id === targetId);
  }

  _activeToolBtn = targetId ? document.getElementById(targetId) : null;
}

// _syncMuteButton -- reflect the true mute state from VP_STATE onto the
// mute button. Overrides the local _muteLocal guess made on click.
//
// @param {boolean} isMuted
function _syncMuteButton(isMuted) {
  const btn = document.getElementById('tool-mute');
  if (!btn) return;
  btn.classList.toggle('muted', isMuted);
  _muteLocal = isMuted;  // keep local tracking in sync
}

// ---------------------------------------------------------------------------
// _setContextualBtn -- create, update, or remove one contextual sidebar button.
//
// Called every poll frame. Create-once: the click listener is attached at
// creation time and never re-added, avoiding duplicate listener accumulation.
// On subsequent frames only the label text and active class are updated.
//
// @param {string}   id    -- element id, e.g. 'ctx-force'
// @param {boolean}  show  -- whether this button should exist right now
// @param {Object}   props
//   .label     {string}   -- button text (e.g. 'frc')
//   .ariaLabel {string}   -- aria-label and title attribute value
//   .isActive  {boolean}  -- whether to show the 'active' (blue) CSS class
//   .onClick   {function} -- click handler; attached once at creation only
// ---------------------------------------------------------------------------
function _setContextualBtn(id, show, props) {
  const zone = document.getElementById('vp-ctx-btns');
  if (!zone) return;

  let btn = document.getElementById(id);

  if (!show) {
    // Button should not exist. Remove it if it does.
    if (btn) btn.remove();
    return;
  }

  if (!btn) {
    // First appearance: create and wire the button. Listener attached once.
    btn = document.createElement('button');
    btn.id        = id;
    btn.className = 'vp-tool-btn';
    btn.setAttribute('aria-label', props.ariaLabel);
    btn.setAttribute('title',      props.ariaLabel);
    btn.setAttribute('tabindex',   '0');
    btn.addEventListener('click', props.onClick);
    zone.appendChild(btn);
  }

  // Update on every frame: label and active highlight.
  btn.textContent = props.label;
  btn.classList.toggle('active', !!props.isActive);
}

// ---------------------------------------------------------------------------
// _syncContextualButtons -- show/hide contextual sidebar buttons per VP_STATE.
//
// Called every poll frame from _poll(). Evaluates world and state conditions
// to decide which contextual buttons to show.
//
// ctx-force: applies force to the outermost right mass (mdof world only).
//   Show when: mdof world AND (forcing is active OR absorber scenario loaded).
//   Active when: state.modalForcingActive is true.
//   Clicking: vpToggleModalForcing()
//
// ctx-strum: strum tool for multi-string world.
//   Show when: strings world.
//   Auto-select: fires vpSetTool('strum') once per world entry.
//   Active when: state.currentTool === 'strum'.
//   Clicking: vpSetTool('strum')
//
// @param {Object} state -- window.VP_STATE snapshot
// ---------------------------------------------------------------------------
function _syncContextualButtons(state) {

  // ---- ctx-force: applied modal force button ----
  // Visible when in mdof world and forcing is relevant: either it is already
  // on, or the absorber scenario (the canonical forcing demo) is loaded.
  const showForce = (state.world === 'mdof') &&
                    (!!state.modalForcingActive ||
                     window.activeScene === 'absorber');

  _setContextualBtn('ctx-force', showForce, {
    label:     'FORCE',
    ariaLabel: 'Toggle applied modal force (F key)',
    isActive:  !!state.modalForcingActive,
    onClick:   function() { if (window.vpToggleModalForcing) window.vpToggleModalForcing(); }
  });

  // ---- ctx-drive: harmonic drive button for membrane world ----
  // Always shown when in the membrane world; default off.
  // isActive tracks harmonicDrive.enabled via VP_STATE.isDriveOn.
  const showDrive = (state.world === 'membrane');
  _setContextualBtn('ctx-drive', showDrive, {
    label:     'DRIVE',
    ariaLabel: 'Toggle harmonic drive at selected mode frequency',
    isActive:  !!state.isDriveOn,
    onClick:   function() { if (window.vpToggleDrive) window.vpToggleDrive(); }
  });

  // ---- ctx-strum: strum tool for strings world, multi-string only ----
  // stringCount is exported by 2D-sketch.js VP_STATE; strum is irrelevant for
  // a single string (nothing to sweep across).
  const showStrum = (state.world === 'strings' && (state.stringCount || 0) > 1);

  if (state.world !== 'strings') {
    // Exiting strings world entirely: reset so the next entry triggers auto-select again.
    _strumAutoSelected = false;
  }

  if (showStrum && !_strumAutoSelected) {
    // First frame with multiple strings: auto-select the strum tool.
    // Guard: _initMultiStrings() may have already set the tool to strum, in which
    // case calling vpSetTool('strum') again would toggle it back to pointer.
    _strumAutoSelected = true;
    if (window.vpSetTool && state.currentTool !== 'strum') window.vpSetTool('strum');
  }

  if (!showStrum && state.world === 'strings' && state.currentTool === 'strum') {
    // Switched from multi to single string while strum was active -- revert to pointer.
    if (window.vpSetTool) window.vpSetTool('pointer');
    _strumAutoSelected = false;
  }

  _setContextualBtn('ctx-strum', showStrum, {
    label:     'STRUM',
    ariaLabel: 'Strum tool -- sweep mouse to pluck all strings (S key)',
    isActive:  (state.currentTool === 'strum'),
    onClick:   function() { if (window.vpSetTool) window.vpSetTool('strum'); }
  });

  // Forcing readouts: visible only while modal forcing is active in mdof world.
  const forcingOn = (state.world === 'mdof' && !!state.modalForcingActive);

  // Hz readout.
  const readout = document.getElementById('vp-forcing-readout');
  if (readout) {
    if (forcingOn && state.modalForcingHz != null) {
      readout.textContent = state.modalForcingHz.toFixed(2) + ' Hz';
      readout.classList.add('visible');
    } else {
      readout.textContent = '';
      readout.classList.remove('visible');
    }
  }

  // Amplitude readout.
  const ampReadout = document.getElementById('vp-forcing-amp-readout');
  if (ampReadout) {
    if (forcingOn && state.modalForcingAmp != null) {
      ampReadout.textContent = state.modalForcingAmp.toFixed(1) + ' N';
      ampReadout.classList.add('visible');
    } else {
      ampReadout.textContent = '';
      ampReadout.classList.remove('visible');
    }
  }

  // Auto-enable modal energy overlay on the off --> on transition.
  if (forcingOn && !_prevForcingActive) {
    const ovlCheck = document.getElementById('ovl-modal-energy');
    if (ovlCheck && !ovlCheck.checked) {
      ovlCheck.checked = true;
      if (!window.VP_OVERLAYS) window.VP_OVERLAYS = {};
      window.VP_OVERLAYS.modalEnergy = true;
    }
  }
  _prevForcingActive = forcingOn;
}

// _poll -- requestAnimationFrame loop that syncs the UI from window.VP_STATE.
//
// Reads VP_STATE exported by sketch.js draw() each frame.
// Bails early (re-schedules) if VP_STATE is not yet available (before setup() runs).
function _poll() {
  const state = window.VP_STATE;
  if (!state) {
    requestAnimationFrame(_poll);
    return;
  }

  // Sync tool button highlights.
  if (state.currentTool !== undefined) {
    _syncToolHighlights(state.currentTool);
  }

  // Sync mute button.
  if (state.isMuted !== undefined) {
    _syncMuteButton(state.isMuted);
  }

  // Sync contextual sidebar buttons (frc, strum) based on VP_STATE.world.
  _syncContextualButtons(state);

  // Sync universal sliders (skipped if the user is currently dragging them).
  if (state.timeScale !== undefined) {
    _syncSliderIfIdle('slider-speed', state.timeScale, v => v.toFixed(2) + 'x');
  }
  if (state.zeta && state.zeta.length > 0) {
    _syncSliderIfIdle('slider-zeta', state.zeta[0], v => v.toFixed(3));
  }
  if (state.dampingSlope !== undefined) {
    _syncSliderIfIdle('slider-slope-zeta', state.dampingSlope, v => v.toFixed(2));
  }

  // World-specific sync (mass rows, mode buttons, forcing readouts, etc.) -- Step 3+.
  if (_worldConfig && _worldConfig.syncUI) {
    _worldConfig.syncUI(state);
  }

  // Helper mode: forward VP_STATE to HelperMode.js each frame when active.
  if (window.vpHelper && window.vpHelper.enabled) {
    window.vpHelper.onStateUpdate(state);
  }

  requestAnimationFrame(_poll);
}

// _startPollLoop -- kick off the rAF poll loop once on init.
function _startPollLoop() {
  requestAnimationFrame(_poll);
}

// ---------------------------------------------------------------------------
// _buildScenesForWorld -- populate #vp-scenes-flyout with scenario buttons.
//
// Called from vpBuildMenu() when config.scenarios is provided.
// Reads window.VP_SCENARIOS[entry.scene] for each entry.
// Clicking a button: stores the preset, sets window.activeScene, calls vpReset(),
// and closes the flyout.
//
// @param {Object} config -- world config (uses config.scenarios array)
// ---------------------------------------------------------------------------
function _buildScenesForWorld(config) {
  const flyout = document.getElementById('vp-scenes-flyout');
  if (!flyout || !config.scenarios) return;

  flyout.innerHTML = '';

  for (const entry of config.scenarios) {
    const sceneKey = entry.scene;
    const btn = document.createElement('button');
    btn.className   = 'vp-scene-btn';
    btn.textContent = entry.label;
    btn.setAttribute('title', entry.label);
    btn.addEventListener('click', () => {
      if (entry.onClick) {
        // World-specific click handler (e.g. membrane uses applyPreset directly).
        entry.onClick();
      } else {
        // Default: load preset from VP_SCENARIOS and call vpReset().
        const scenarios = window.VP_SCENARIOS;
        if (!scenarios || !scenarios[sceneKey]) return;
        // Store the preset so resetToPreset() reads the new configuration.
        window.storedPresetJSON = scenarios[sceneKey];
        // activeScene is read by sketch.js draw() for absorber resonance display.
        window.activeScene = sceneKey;
        if (window.vpReset) window.vpReset();
        // Dynamic absorber is the canonical forcing demo -- turn forcing on
        // automatically after reset (reset always clears it).
        if (sceneKey === 'absorber' && window.vpToggleModalForcing) {
          window.vpToggleModalForcing();
        }

        // Fourier scenario: auto-enable both Fourier overlay and modal energy overlay.
        // The two overlays are complementary -- the modal energy bars show which
        // modes are active while the Fourier curves show their spatial shapes.
        if (sceneKey === 'fourier') {
          if (!window.VP_OVERLAYS) window.VP_OVERLAYS = {};
          window.VP_OVERLAYS.fourier     = true;
          window.VP_OVERLAYS.modalEnergy = true;
          const fourierCb    = document.getElementById('ovl-fourier');
          const modalEnergyCb = document.getElementById('ovl-string-modal-energy');
          if (fourierCb)     fourierCb.checked     = true;
          if (modalEnergyCb) modalEnergyCb.checked = true;
        }
      }
      // Flyout stays open after selection -- user may want to try another scenario.
    });
    flyout.appendChild(btn);
  }

  // ---- Mode Shapes section (membrane world) ----
  // 5-column grid. Buttons are (mx,my) labels. Grid is populated by
  // _rebuildFlyoutMembraneModeButtons() called from membrane-sketch.js
  // _buildModeButtons() whenever mode labels change (BC toggle, aspect ratio).
  if (config.world === 'membrane') {
    const hdr = document.createElement('div');
    hdr.className   = 'vp-flyout-hdr';
    hdr.textContent = 'Mode Shapes';
    flyout.appendChild(hdr);

    const grid = document.createElement('div');
    grid.id = 'flyout-membrane-mode-grid';
    flyout.appendChild(grid);
  }

  // ---- Mode Shapes section (mass world) ----
  // Grid is populated by _rebuildFlyoutModeButtons() each time nFree changes.
  if (config.world === 'mass') {
    const hdr = document.createElement('div');
    hdr.className   = 'vp-flyout-hdr';
    hdr.textContent = 'Mode Shapes';
    flyout.appendChild(hdr);

    const grid = document.createElement('div');
    grid.id = 'flyout-mode-grid';
    flyout.appendChild(grid);
  }

  // ---- Mode Shapes section (lattice world) ----
  // 6-column grid. Mode 1 (index 0) is the rigid-body mode and is skipped.
  // Grid content is rebuilt by _latticeSyncUI() when the shell count changes.
  if (config.world === 'lattice') {
    const hdr = document.createElement('div');
    hdr.className   = 'vp-flyout-hdr';
    hdr.textContent = 'Mode Shapes';
    flyout.appendChild(hdr);

    const grid = document.createElement('div');
    grid.id = 'flyout-lattice-mode-grid';
    flyout.appendChild(grid);
  }

  // ---- Mode Shapes section (strings world) ----
  // Fixed 4x4 grid (modes 1-16). Shown only for single string; grayed when
  // multi-string is active. Clicking calls vpLaunchStringMode(n) which sets
  // the standing-wave mode and drops damping to minimum.
  if (config.world === 'strings') {
    const hdr = document.createElement('div');
    hdr.className   = 'vp-flyout-hdr';
    hdr.id          = 'string-mode-hdr';
    hdr.textContent = 'Mode Shapes';
    flyout.appendChild(hdr);

    const grid = document.createElement('div');
    grid.id        = 'flyout-string-mode-grid';
    grid.className = 'vp-flyout-mode-grid-section';
    flyout.appendChild(grid);

    // Build 16 buttons once (mode numbers never change for strings).
    for (let n = 0; n < 16; n++) {
      const btn = document.createElement('button');
      btn.className    = 'vp-flyout-mode-btn';
      btn.textContent  = String(n + 1);
      btn.dataset.mode = String(n);   // 0-based index stored for title updates
      btn.title        = 'Mode ' + (n + 1);
      const idx = n;
      btn.addEventListener('click', () => {
        if (window.vpLaunchStringMode) window.vpLaunchStringMode(idx);
      });
      grid.appendChild(btn);
    }
  }
}

// ---------------------------------------------------------------------------
// _rebuildFlyoutModeButtons -- rebuild the 4-column mode-shape grid in the flyout.
//
// Mirrors _rebuildModeButtons() but targets the flyout grid instead of the
// physics tab.  Each button shows the mode number only; the Hz value appears
// in the title tooltip.  Buttons are arranged in a 4-column CSS grid so that
// adding a 5th mode wraps to a second row automatically.
//
// Called from _massSyncUI() alongside _rebuildModeButtons() whenever nFree changes.
//
// @param {Object} state -- VP_STATE snapshot (uses nFree, freqs[])
// ---------------------------------------------------------------------------
function _rebuildFlyoutModeButtons(state) {
  const grid = document.getElementById('flyout-mode-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const nFree = state.nFree;
  const freqs = state.freqs || [];

  for (let n = 0; n < nFree; n++) {
    const btn    = document.createElement('button');
    btn.className   = 'vp-flyout-mode-btn';
    btn.textContent = String(n + 1);    // 1-based mode number
    const hzStr = (freqs[n] !== undefined) ? freqs[n].toFixed(2) + ' Hz' : '';
    btn.title    = 'Mode ' + (n + 1) + (hzStr ? '  \u2014  ' + hzStr : '');
    const idx = n;   // capture loop variable for closure
    btn.addEventListener('click', () => {
      if (window.vpLaunchModeShape) window.vpLaunchModeShape(idx);
    });
    grid.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// _rebuildFlyoutLatticeModeButtons -- rebuild the 6-column mode grid in the
// lattice scenarios flyout.
//
// Skips mode 1 (index 0), which is always the zero-frequency rigid-body mode.
// Called from _latticeSyncUI() whenever latticeModeCount changes (i.e. when
// the user switches shells via a scenario button).
//
// @param {number} N -- total mode count from VP_STATE.latticeModeCount
// ---------------------------------------------------------------------------
function _rebuildFlyoutLatticeModeButtons(N) {
  const grid = document.getElementById('flyout-lattice-mode-grid');
  if (!grid) return;
  grid.innerHTML = '';

  // Modes are 0-based internally; display 1-based labels.
  // Skip n=0 (rigid-body mode -- omega near zero, no useful sound).
  for (let n = 1; n < N; n++) {
    const btn = document.createElement('button');
    btn.className   = 'vp-flyout-mode-btn';
    btn.textContent = String(n + 1);   // 1-based: n=1 -> label '2', etc.
    btn.title       = 'Mode ' + (n + 1);
    const idx = n;
    btn.addEventListener('click', () => {
      if (window.vpLaunchLatticeMode) window.vpLaunchLatticeMode(idx);
    });
    grid.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// _rebuildFlyoutMembraneModeButtons -- rebuild the 5-column mode grid in the
// membrane scenarios flyout.
//
// Called from membrane-sketch.js _buildModeButtons() whenever the mode list
// changes (BC toggle, aspect-ratio change, or initial setup).
//
// @param {string[]} labels  -- display labels for each mode, e.g. ['(1,1)', '(1,2)', ...]
//                              Length = membraneDef.N (number of retained modes)
// @param {boolean[]} isDeg  -- true for each mode that is part of a degenerate pair;
//                              degenerate buttons are tinted amber
// ---------------------------------------------------------------------------
function _rebuildFlyoutMembraneModeButtons(labels, isDeg) {
  const grid = document.getElementById('flyout-membrane-mode-grid');
  if (!grid) return;
  grid.innerHTML = '';

  for (let n = 0; n < labels.length; n++) {
    const btn = document.createElement('button');
    btn.className   = 'vp-flyout-mode-btn';
    btn.textContent = labels[n];
    btn.title       = 'Mode ' + labels[n];
    // Amber tint for degenerate pairs (same omega as another mode).
    if (isDeg && isDeg[n]) {
      btn.style.color       = '#ffd080';
      btn.style.borderColor = '#886020';
    }
    const idx = n;   // capture for closure
    btn.addEventListener('click', () => {
      if (window.vpLaunchMembraneMode) window.vpLaunchMembraneMode(idx);
    });
    grid.appendChild(btn);
  }
}

// Expose so membrane-sketch.js can call it after _buildModeButtons().
window.vpRebuildMembraneModeButtons = _rebuildFlyoutMembraneModeButtons;

// ---------------------------------------------------------------------------
// _buildMassGeometryTab -- populate #vp-tab-geometry for the mass world.
//
// Builds static structure: add/remove buttons, group-action buttons, and
// a container div for dynamic per-mass rows. The container is populated by
// _rebuildMassRows() the first time _massSyncUI() runs with valid VP_STATE.
// ---------------------------------------------------------------------------
function _buildMassGeometryTab() {
  const panel = document.getElementById('vp-tab-geometry');
  if (!panel) return;

  panel.innerHTML = '';

  // ---- Add / remove mass buttons ----
  const addHdr = document.createElement('div');
  addHdr.className   = 'vp-ctrl-hdr';
  addHdr.textContent = 'add / remove';
  panel.appendChild(addHdr);

  const addRow = document.createElement('div');
  addRow.className = 'vp-action-row';

  const addDefs = [
    { label: '+L', title: 'Add mass on the left',  fn: () => { if (window.vpAddMass)    window.vpAddMass('left');    } },
    { label: '-L', title: 'Remove leftmost mass',   fn: () => { if (window.vpRemoveMass) window.vpRemoveMass('left');  } },
    { label: '+R', title: 'Add mass on the right', fn: () => { if (window.vpAddMass)    window.vpAddMass('right');   } },
    { label: '-R', title: 'Remove rightmost mass',  fn: () => { if (window.vpRemoveMass) window.vpRemoveMass('right'); } },
  ];
  for (const d of addDefs) {
    const b = document.createElement('button');
    b.className   = 'vp-act-btn';
    b.textContent = d.label;
    b.title       = d.title;
    b.addEventListener('click', d.fn);
    addRow.appendChild(b);
  }
  panel.appendChild(addRow);

  // ---- Group actions: couple/ground all ----
  const groupHdr = document.createElement('div');
  groupHdr.className   = 'vp-ctrl-hdr';
  groupHdr.textContent = 'all masses';
  panel.appendChild(groupHdr);

  const groupRow = document.createElement('div');
  groupRow.className = 'vp-action-row';

  const groupDefs = [
    { label: 'couple all',   title: 'Add coupling springs between all adjacent pairs (k=50)', fn: () => { if (window.vpCoupleAll)   window.vpCoupleAll();   } },
    { label: 'uncouple all', title: 'Remove all coupling springs',                              fn: () => { if (window.vpUncoupleAll) window.vpUncoupleAll(); } },
    { label: 'ground all',   title: 'Add ground springs to all masses (k=10)',                  fn: () => { if (window.vpGroundAll)   window.vpGroundAll();   } },
    { label: 'unground all', title: 'Remove all ground springs',                                fn: () => { if (window.vpUngroundAll) window.vpUngroundAll(); } },
  ];
  for (const d of groupDefs) {
    const b = document.createElement('button');
    b.className   = 'vp-act-btn';
    b.textContent = d.label;
    b.title       = d.title;
    b.addEventListener('click', d.fn);
    groupRow.appendChild(b);
  }
  panel.appendChild(groupRow);

  // ---- Dynamic mass rows (filled by _rebuildMassRows) ----
  const massHdr = document.createElement('div');
  massHdr.className   = 'vp-ctrl-hdr';
  massHdr.textContent = 'masses';
  panel.appendChild(massHdr);

  const container = document.createElement('div');
  container.id = 'mass-rows-container';
  panel.appendChild(container);
}

// ---------------------------------------------------------------------------
// _rebuildMassRows -- build per-mass slider rows from VP_STATE.
//
// Called from _massSyncUI() when the mass count changes (add/remove mass events).
// Rows appear in visual order, left to right.
//
// Each row:
//   label  -- side and position: L2, L1, R1, R2, ...
//   m      -- mass slider (0.1 to 10, step 0.1), calls vpSetMass(physIdx, v)
//   kG     -- ground spring slider (0 to 200, step 1), calls vpSetKGround(physIdx, v)
//
// Between adjacent visual pairs: a coupling-toggle button.
//   Uncoupled: dashed border, "uncoupled". Click -> vpSetCoupling(a, b, 50).
//   Coupled:   solid green border, "k=XX".   Click -> vpSetCoupling(a, b, 0).
//
// @param {Object} state -- VP_STATE snapshot (uses visualOrder, masses, kGround,
//                          couplings, nLeft, nRight)
// ---------------------------------------------------------------------------
function _rebuildMassRows(state) {
  const container = document.getElementById('mass-rows-container');
  if (!container) return;
  container.innerHTML = '';

  const N = state.nMasses;
  if (N === 0) return;  // string world or empty state: leave container blank

  const vo      = state.visualOrder;   // physics indices in left-to-right visual order
  const nLeft   = state.nLeft;
  const masses  = state.masses;
  const kGround = state.kGround;

  for (let vi = 0; vi < vo.length; vi++) {
    const physIdx = vo[vi];

    // Compute side label.
    // Left side (vi < nLeft): outermost is L{nLeft}, innermost is L1.
    // Right side (vi >= nLeft): innermost is R1, outermost is R{nRight}.
    let label;
    if (vi < nLeft) {
      label = 'L' + (nLeft - vi);
    } else {
      label = 'R' + (vi - nLeft + 1);
    }

    // ---- Mass row ----
    const massRow = document.createElement('div');
    massRow.className          = 'vp-mass-row';
    massRow.dataset.physIdx    = physIdx;

    // Side label
    const labelEl = document.createElement('span');
    labelEl.className   = 'vp-mass-lbl';
    labelEl.textContent = label;
    massRow.appendChild(labelEl);

    // Helper: build a slider column [label] [slider] [value]
    function _makeParamCol(paramLabel, sliderId, valId, min, max, step, initVal, fmtFn, onChange) {
      const col = document.createElement('div');
      col.className = 'vp-mass-col';

      const lbl = document.createElement('span');
      lbl.className   = 'vp-param-lbl';
      lbl.textContent = paramLabel;

      const sl = document.createElement('input');
      sl.type  = 'range';
      sl.id    = sliderId;
      sl.min   = min;
      sl.max   = max;
      sl.step  = step;
      sl.value = initVal;
      sl.setAttribute('aria-label', paramLabel + ' for mass ' + label);

      const valEl = document.createElement('span');
      valEl.className   = 'vp-param-val';
      valEl.id          = valId;
      valEl.textContent = fmtFn(initVal);

      // Idle tracking: poll sync skips this slider while user is dragging.
      sl._isDragging = false;
      sl.addEventListener('pointerdown', () => { sl._isDragging = true;  });
      sl.addEventListener('pointerup',   () => { sl._isDragging = false; });
      sl.addEventListener('blur',        () => { sl._isDragging = false; });

      sl.addEventListener('input', () => {
        const v = parseFloat(sl.value);
        valEl.textContent = fmtFn(v);
        onChange(v);
      });

      col.appendChild(lbl);
      col.appendChild(sl);
      col.appendChild(valEl);
      return col;
    }

    // Mass slider (m): 0.1 to 10
    const mInit = (masses[physIdx] !== undefined) ? masses[physIdx] : 1;
    massRow.appendChild(_makeParamCol(
      'm',
      'slider-m-'  + physIdx,
      'val-m-'     + physIdx,
      0.1, 10, 0.1,
      mInit,
      v => v.toFixed(1),
      v => { if (window.vpSetMass)    window.vpSetMass(physIdx, v); }
    ));

    // kGround slider (kG): 0 to 200
    const kgInit = (kGround[physIdx] !== undefined) ? kGround[physIdx] : 0;
    massRow.appendChild(_makeParamCol(
      'kG',
      'slider-kg-' + physIdx,
      'val-kg-'    + physIdx,
      0, 200, 1,
      kgInit,
      v => Math.round(v),
      v => { if (window.vpSetKGround) window.vpSetKGround(physIdx, v); }
    ));

    container.appendChild(massRow);

    // ---- Coupling row between this mass and the next ----
    if (vi < vo.length - 1) {
      const nextPhysIdx = vo[vi + 1];
      // Coupling key is always min-max to match VP_STATE.couplings format.
      const coupKey = Math.min(physIdx, nextPhysIdx) + '-' + Math.max(physIdx, nextPhysIdx);
      const isCoupled  = !!(state.couplings && state.couplings[coupKey] !== undefined);
      const kCoup      = isCoupled ? state.couplings[coupKey] : 0;

      const coupRow = document.createElement('div');
      coupRow.className = 'vp-coup-row';

      const coupBtn = document.createElement('button');
      coupBtn.className   = 'vp-coup-btn' + (isCoupled ? ' coupled' : '');
      coupBtn.id          = 'coup-btn-' + coupKey;
      coupBtn.textContent = isCoupled ? ('k=' + Math.round(kCoup)) : 'uncoupled';
      coupBtn.title = isCoupled
        ? 'Coupled (k=' + Math.round(kCoup) + '). Click to remove.'
        : 'Click to add coupling spring (k=50)';

      // Capture both physics indices for the click closure.
      const pA = physIdx;
      const pB = nextPhysIdx;
      coupBtn.addEventListener('click', () => {
        const currentlyCoupled = coupBtn.classList.contains('coupled');
        if (currentlyCoupled) {
          if (window.vpSetCoupling) window.vpSetCoupling(pA, pB, 0);
        } else {
          if (window.vpSetCoupling) window.vpSetCoupling(pA, pB, 50);
        }
        // _massSyncUI will update the button text on the next poll frame.
      });

      coupRow.appendChild(coupBtn);
      container.appendChild(coupRow);
    }
  }
}

// ---------------------------------------------------------------------------
// _buildMassPhysicsExtras -- append mass-world physics controls to #vp-tab-physics.
//
// Appended below the universal controls (speed/damp/slope) already built by
// _buildPhysicsTab(). Adds:
//   1. Applied force section: toggle button + frequency slider + amplitude slider.
//   2. Mode shapes section: container for buttons built by _rebuildModeButtons().
//
// Wires:
//   vpToggleModalForcing()  -- toggle applied harmonic force on outermost mass
//   vpSetModalForcingHz(hz) -- change forcing frequency
//   vpSetForcingAmp(amp)    -- change forcing amplitude
//   vpLaunchModeShape(n)    -- set initial condition to mode shape n (0-based)
// ---------------------------------------------------------------------------
function _buildMassPhysicsExtras() {
  const panel = document.getElementById('vp-tab-physics');
  if (!panel) return;

  // ---- Applied force section ----
  const forceHdr = document.createElement('div');
  forceHdr.className   = 'vp-ctrl-hdr';
  forceHdr.textContent = 'applied force  (F key)';
  panel.appendChild(forceHdr);

  // Toggle row: single button, toggles active class and label in syncUI.
  const forceToggleRow = document.createElement('div');
  forceToggleRow.className = 'vp-action-row';
  const forceBtn = document.createElement('button');
  forceBtn.id          = 'btn-force-toggle';
  forceBtn.className   = 'vp-act-btn';
  forceBtn.textContent = 'force: off';
  forceBtn.title       = 'Toggle applied harmonic force on outermost right mass';
  forceBtn.addEventListener('click', () => {
    if (window.vpToggleModalForcing) window.vpToggleModalForcing();
  });
  forceToggleRow.appendChild(forceBtn);
  panel.appendChild(forceToggleRow);

  // Frequency slider: 0.1 to 5 Hz, step 0.05.
  // Nudge with UP/DOWN arrow keys also works (bypasses slider).
  panel.appendChild(_makeSliderRow({
    id:       'slider-force-hz',
    label:    'freq',
    min:      0.1,
    max:      5.0,
    step:     0.05,
    value:    1.0,
    fmtFn:    v => v.toFixed(2) + ' Hz',
    onChange: v => { if (window.vpSetModalForcingHz) window.vpSetModalForcingHz(v); }
  }));

  // Amplitude slider: 0.1 to 5 N.
  panel.appendChild(_makeSliderRow({
    id:       'slider-force-amp',
    label:    'amp',
    min:      0.1,
    max:      5.0,
    step:     0.1,
    value:    1.0,
    fmtFn:    v => v.toFixed(1) + ' N',
    onChange: v => { if (window.vpSetForcingAmp) window.vpSetForcingAmp(v); }
  }));

  // ---- Overlay checkboxes section ----
  // Each checkbox sets the matching key on window.VP_OVERLAYS.
  // MassVisualObserver.drawMulti() reads VP_OVERLAYS each frame and calls
  // drawModeShapeOverlay() or drawModalEnergyOverlay() when the flag is set.
  const ovlHdr = document.createElement('div');
  ovlHdr.className   = 'vp-ctrl-hdr';
  ovlHdr.textContent = 'overlays';
  panel.appendChild(ovlHdr);

  // Helper: one checkbox row -- id, display label, VP_OVERLAYS key to toggle.
  // @param {string} id       -- HTML element id for the <input>
  // @param {string} labelTxt -- visible label text next to the checkbox
  // @param {string} ovlKey   -- key on window.VP_OVERLAYS to set true/false
  function _addOverlayCheckbox(id, labelTxt, ovlKey) {
    const row   = document.createElement('div');
    row.className = 'vp-check-row';

    const lbl   = document.createElement('label');
    const input = document.createElement('input');
    input.type  = 'checkbox';
    input.id    = id;

    input.addEventListener('change', function () {
      // Ensure VP_OVERLAYS exists (it may not be set yet on first interaction).
      if (!window.VP_OVERLAYS) window.VP_OVERLAYS = {};
      window.VP_OVERLAYS[ovlKey] = this.checked;
    });

    lbl.appendChild(input);
    lbl.appendChild(document.createTextNode(' ' + labelTxt));
    row.appendChild(lbl);
    panel.appendChild(row);
  }

  _addOverlayCheckbox('ovl-mode-shapes', 'mode shapes',  'modeShapes');
  _addOverlayCheckbox('ovl-modal-energy', 'modal energy', 'modalEnergy');
  _addOverlayCheckbox('ovl-phase',        'phase angle',  'phase');

  // ---- Mode shapes section ----
  const modeHdr = document.createElement('div');
  modeHdr.className   = 'vp-ctrl-hdr';
  modeHdr.textContent = 'mode shapes';
  panel.appendChild(modeHdr);

  // Container filled by _rebuildModeButtons() each time nFree changes.
  const modeContainer = document.createElement('div');
  modeContainer.id        = 'mode-btn-row';
  modeContainer.className = 'vp-action-row';
  panel.appendChild(modeContainer);

  // Frequency list: one line per mode, populated by _rebuildModeButtons().
  const freqList = document.createElement('div');
  freqList.id        = 'mass-freq-list';
  freqList.className = 'vp-freq-list';
  panel.appendChild(freqList);
}

// ---------------------------------------------------------------------------
// _rebuildModeButtons -- build one launch button per free mode.
//
// Called from _massSyncUI() when nFree changes (topology change or hold/release).
// Each button shows the mode number (1-based) and frequency in Hz.
// Clicking calls vpLaunchModeShape(n) with 0-based mode index.
//
// @param {Object} state -- VP_STATE snapshot (uses nFree, freqs[])
// ---------------------------------------------------------------------------
function _rebuildModeButtons(state) {
  const container = document.getElementById('mode-btn-row');
  if (!container) return;
  container.innerHTML = '';

  const nFree = state.nFree;
  const freqs = state.freqs || [];

  for (let n = 0; n < nFree; n++) {
    const btn = document.createElement('button');
    btn.className   = 'vp-act-btn';
    const hzStr = (freqs[n] !== undefined) ? freqs[n].toFixed(2) + ' Hz' : '';
    btn.textContent = 'mode ' + (n + 1);
    btn.title       = 'Launch mode ' + (n + 1) + (hzStr ? ' -- ' + hzStr : '');
    const idx = n;  // capture for closure (n changes each iteration)
    btn.addEventListener('click', () => {
      if (window.vpLaunchModeShape) window.vpLaunchModeShape(idx);
    });
    container.appendChild(btn);
  }

  // Populate the frequency list below the buttons.
  const freqListEl = document.getElementById('mass-freq-list');
  if (freqListEl) {
    freqListEl.textContent = freqs.slice(0, nFree).map((hz, n) =>
      String(n + 1).padStart(2) + '  ' + (hz !== undefined ? hz.toFixed(1) + ' Hz' : '--')
    ).join('\n');
  }
}

// ---------------------------------------------------------------------------
// _buildMassSoundTab -- populate #vp-tab-sound for the mass world.
//
// Two controls:
//   detune -- pitch disorder for coupling bandpass voices.
//             0 = no drift; 50 = wide spectral spread.
//             Wires to vpSetDetune(cents).
//   root   -- base pitch for the tonnetz fifths chain.
//             Preset buttons: A1 (55 Hz), D2 (73 Hz), A2 (110 Hz), A3 (220 Hz).
//             Wires to vpSetBasePitch(hz).
// ---------------------------------------------------------------------------
function _buildMassSoundTab() {
  const panel = document.getElementById('vp-tab-sound');
  if (!panel) return;

  panel.innerHTML = '';

  // Detune slider
  const detuneHdr = document.createElement('div');
  detuneHdr.className   = 'vp-ctrl-hdr';
  detuneHdr.textContent = 'coupling voices';
  panel.appendChild(detuneHdr);

  panel.appendChild(_makeSliderRow({
    id:       'slider-detune',
    label:    'detune',
    min:      0,
    max:      50,
    step:     1,
    value:    15,
    fmtFn:    v => Math.round(v) + ' ct',
    onChange: v => { if (window.vpSetDetune) window.vpSetDetune(v); }
  }));

  // Root pitch preset buttons
  const rootHdr = document.createElement('div');
  rootHdr.className   = 'vp-ctrl-hdr';
  rootHdr.textContent = 'root pitch';
  panel.appendChild(rootHdr);

  const rootRow = document.createElement('div');
  rootRow.className = 'vp-action-row';
  rootRow.id        = 'root-btn-row';

  const pitches = [
    { label: 'A1',  hz: 55.0   },
    { label: 'D2',  hz: 73.4   },
    { label: 'A2',  hz: 110.0  },
    { label: 'A3',  hz: 220.0  },
  ];
  for (const p of pitches) {
    const btn = document.createElement('button');
    btn.className   = 'vp-act-btn';
    btn.textContent = p.label;
    btn.title       = p.label + ' = ' + p.hz + ' Hz';
    const pitchHz = p.hz;
    btn.addEventListener('click', () => {
      if (window.vpSetBasePitch) window.vpSetBasePitch(pitchHz);
      // Highlight active pitch button.
      rootRow.querySelectorAll('.vp-act-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    rootRow.appendChild(btn);
  }
  panel.appendChild(rootRow);
}

// ---------------------------------------------------------------------------
// _massSyncUI -- per-frame sync function for the mass world.
//
// Assigned to _worldConfig.syncUI by vpBuildMenu() when world = 'mass'.
// Called by _poll() each animation frame after VP_STATE is available.
//
// Responsibility:
//   - Detect topology changes (nMasses, nFree) and trigger DOM rebuilds.
//   - Sync per-mass sliders when not being dragged.
//   - Sync coupling button states (toggle via canvas also changes couplings).
//   - Sync forcing toggle button and sliders.
//
// @param {Object} state -- window.VP_STATE snapshot from sketch.js draw()
// ---------------------------------------------------------------------------
function _massSyncUI(state) {
  // ---- Topology change: mass count ----
  // Triggered by add/remove mass, or switching world (nMasses=0 for string world).
  if (state.nMasses !== _prevNMasses) {
    _rebuildMassRows(state);
    _prevNMasses = state.nMasses;
    // Force mode-button rebuild on the same frame (nFree also changed).
    _prevNFree = -1;
  }

  // ---- Topology change: free-mode count ----
  // Triggered by add/remove mass, or hold/release (fixed mass reduces nFree).
  if (state.nFree !== _prevNFree) {
    _rebuildModeButtons(state);
    _rebuildFlyoutModeButtons(state);   // mirror in scenarios flyout
    _prevNFree = state.nFree;
  }

  // ---- Sync per-mass sliders ----
  // Only updates when the user is not actively dragging the slider.
  const vo = state.visualOrder || [];
  for (const physIdx of vo) {
    // Mass slider
    _syncSliderIfIdle('slider-m-'  + physIdx,
      state.masses[physIdx],
      v => parseFloat(v).toFixed(1));
    // kGround slider
    _syncSliderIfIdle('slider-kg-' + physIdx,
      state.kGround[physIdx],
      v => Math.round(v));
  }

  // ---- Sync coupling toggle buttons ----
  // Coupling can change via canvas clicks without a topology change.
  for (let vi = 0; vi < vo.length - 1; vi++) {
    const a   = vo[vi];
    const b   = vo[vi + 1];
    const key = Math.min(a, b) + '-' + Math.max(a, b);
    const btn = document.getElementById('coup-btn-' + key);
    if (!btn) continue;
    const isCoupled = !!(state.couplings && state.couplings[key] !== undefined);
    const kCoup     = isCoupled ? state.couplings[key] : 0;
    btn.classList.toggle('coupled', isCoupled);
    btn.textContent = isCoupled ? ('k=' + Math.round(kCoup)) : 'uncoupled';
    btn.title = isCoupled
      ? 'Coupled (k=' + Math.round(kCoup) + '). Click to remove.'
      : 'Click to add coupling spring (k=50)';
  }

  // ---- Sync forcing toggle button ----
  const forceBtn = document.getElementById('btn-force-toggle');
  if (forceBtn) {
    const isOn = !!state.modalForcingActive;
    forceBtn.classList.toggle('active', isOn);
    forceBtn.textContent = isOn ? 'force: on' : 'force: off';
  }

  // ---- Sync forcing frequency slider ----
  if (state.modalForcingHz !== undefined) {
    _syncSliderIfIdle('slider-force-hz', state.modalForcingHz, v => v.toFixed(2) + ' Hz');
  }

  // ---- Sync forcing amplitude slider ----
  if (state.modalForcingAmp !== undefined) {
    _syncSliderIfIdle('slider-force-amp', state.modalForcingAmp, v => v.toFixed(1) + ' N');
  }
}

// ---------------------------------------------------------------------------
// _membraneSyncUI -- per-frame sync function for the membrane world.
//
// Assigned to _worldConfig.syncUI by vpBuildMenu() when world = 'membrane'.
// Syncs: aspect ratio slider, tension slider, drive amplitude slider,
// and the drive button text/state (redundant with ctx-drive but keeps the
// in-panel button in sync too).
//
// @param {Object} state -- window.VP_STATE snapshot from membrane-sketch.js draw()
// ---------------------------------------------------------------------------
function _membraneSyncUI(state) {
  // Sync aspect ratio slider (idle-guard prevents overwriting during drag).
  if (state.memAspect !== undefined) {
    _syncSliderIfIdle('slider-mem-aspect', state.memAspect, v => v.toFixed(2));
  }
  // Sync tension slider.
  if (state.memTension !== undefined) {
    _syncSliderIfIdle('slider-mem-tension', state.memTension, v => Math.round(v));
  }
  // Sync drive amplitude slider.
  if (state.memDriveAmp !== undefined) {
    _syncSliderIfIdle('slider-mem-drive-amp', state.memDriveAmp, v => v.toFixed(1));
  }
  // Sync the in-panel drive button text and active class.
  const driveBtn = document.getElementById('drive-btn');
  if (driveBtn) {
    driveBtn.classList.toggle('active', !!state.isDriveOn);
    driveBtn.textContent = state.isDriveOn ? 'drive on' : 'drive off';
  }
}

// ---------------------------------------------------------------------------
// _buildMembraneGeometryTab -- populate #vp-tab-geometry for the membrane world.
//
// Appends: aspect ratio slider + boundary condition indicator row.
// The BC indicators (#bc-left, #bc-right, etc.) are updated by membrane-sketch.js
// directly; Menu.js just provides the container with the element IDs in place.
// ---------------------------------------------------------------------------
function _buildMembraneGeometryTab() {
  const panel = document.getElementById('vp-tab-geometry');
  if (!panel) return;
  panel.innerHTML = '';

  // ---- Aspect ratio (Ly/Lx) ----
  const arHdr = document.createElement('div');
  arHdr.className   = 'vp-ctrl-hdr';
  arHdr.textContent = 'dimensions';
  panel.appendChild(arHdr);

  // Build using _makeSliderRow so idle-drag tracking is included.
  // ID follows slider-* convention so _makeSliderRow builds val-mem-aspect correctly.
  const arRow = _makeSliderRow({
    id:       'slider-mem-aspect',
    label:    'Ly/Lx',
    min:      0.5,
    max:      2.0,
    step:     0.01,
    value:    1.2,
    fmtFn:    v => v.toFixed(2),
    // oninput: throttled pending update (applied at most every 4 draw frames)
    onChange: v => { if (window.onAspectRatioInput) window.onAspectRatioInput(v); }
  });
  panel.appendChild(arRow);
  // onchange: fires once on slider release -- apply exact final value immediately.
  const slAspect = arRow.querySelector('input[type="range"]');
  if (slAspect) {
    slAspect.addEventListener('change', function() {
      if (window.onAspectRatioChange) window.onAspectRatioChange(parseFloat(this.value));
    });
  }

  // ---- Boundary conditions ----
  const bcHdr = document.createElement('div');
  bcHdr.className   = 'vp-ctrl-hdr';
  bcHdr.textContent = 'boundary conditions  (click canvas edge to toggle)';
  panel.appendChild(bcHdr);

  const bcRow = document.createElement('div');
  bcRow.id        = 'bc-indicator';
  bcRow.className = 'vp-action-row';
  // The four spans: membrane-sketch.js updates their className and textContent.
  const edges = [
    { id: 'bc-left',   text: 'left: free'   },
    { id: 'bc-right',  text: 'right: free'  },
    { id: 'bc-bottom', text: 'bottom: free' },
    { id: 'bc-top',    text: 'top: free'    }
  ];
  for (const e of edges) {
    const span = document.createElement('span');
    span.id          = e.id;
    span.className   = 'bc-edge free';  // _syncBCIndicators() updates this to bc-edge fixed/free
    span.textContent = e.text;
    bcRow.appendChild(span);
  }
  panel.appendChild(bcRow);
}

// ---------------------------------------------------------------------------
// _buildMembranePhysicsExtras -- append membrane-specific controls to #vp-tab-physics.
//
// Appended after the universal speed/damp/slope sliders built by _buildPhysicsTab().
// Adds: tension slider, harmonic drive section, mode shapes container.
// ---------------------------------------------------------------------------
function _buildMembranePhysicsExtras() {
  const panel = document.getElementById('vp-tab-physics');
  if (!panel) return;

  // ---- Tension ----
  const tensionHdr = document.createElement('div');
  tensionHdr.className   = 'vp-ctrl-hdr';
  tensionHdr.textContent = 'surface tension';
  panel.appendChild(tensionHdr);

  panel.appendChild(_makeSliderRow({
    id:       'slider-mem-tension',
    label:    'T (N/m)',
    min:      10,
    max:      400,
    step:     1,
    value:    97,
    fmtFn:    v => Math.round(v),
    onChange: v => { if (window.onTensionInput) window.onTensionInput(v); }
  }));

  // ---- Harmonic drive ----
  const driveHdr = document.createElement('div');
  driveHdr.className   = 'vp-ctrl-hdr';
  driveHdr.textContent = 'harmonic drive  (keys 1-9 select mode, 0 = off)';
  panel.appendChild(driveHdr);

  // Mode select + drive toggle button on one row
  const driveRow = document.createElement('div');
  driveRow.className = 'vp-action-row';

  const sel = document.createElement('select');
  sel.id        = 'drive-mode-select';
  sel.className = 'vp-act-btn';
  sel.style.flexGrow = '1';
  sel.addEventListener('change', function() {
    if (window.onHarmonicModeChange) window.onHarmonicModeChange(+this.value);
  });

  const driveBtn = document.createElement('button');
  driveBtn.id          = 'drive-btn';
  driveBtn.className   = 'vp-act-btn';
  driveBtn.textContent = 'drive off';
  driveBtn.addEventListener('click', function() {
    if (window.onDriveToggle) window.onDriveToggle();
  });

  driveRow.appendChild(sel);
  driveRow.appendChild(driveBtn);
  panel.appendChild(driveRow);

  // Drive amplitude slider
  panel.appendChild(_makeSliderRow({
    id:       'slider-mem-drive-amp',
    label:    'amp',
    min:      0.1,
    max:      8.0,
    step:     0.1,
    value:    2.0,
    fmtFn:    v => v.toFixed(1),
    onChange: v => { if (window.onHarmonicAmpChange) window.onHarmonicAmpChange(v); }
  }));

  // ---- Display diagnostics ----
  const displayHdr = document.createElement('div');
  displayHdr.className   = 'vp-ctrl-hdr';
  displayHdr.textContent = 'display';
  panel.appendChild(displayHdr);

  // Color wireframe checkbox: toggles displacement-sign coloring on the mesh.
  // Calls window.onColorToggle() (exported by membrane-sketch.js).
  const colorRow   = document.createElement('div');
  colorRow.className = 'vp-check-row';
  const colorLabel = document.createElement('label');
  const colorCb    = document.createElement('input');
  colorCb.type  = 'checkbox';
  colorCb.id    = 'color-checkbox';
  colorCb.addEventListener('change', function () {
    if (window.onColorToggle) window.onColorToggle();
  });
  colorLabel.appendChild(colorCb);
  colorLabel.appendChild(document.createTextNode(' color wireframe'));
  colorRow.appendChild(colorLabel);
  panel.appendChild(colorRow);

  // ---- Mode shapes ----
  const modeHdr = document.createElement('div');
  modeHdr.className   = 'vp-ctrl-hdr';
  modeHdr.textContent = 'mode shapes  (click to isolate, click again to release)';
  panel.appendChild(modeHdr);

  const modeBtnRow = document.createElement('div');
  modeBtnRow.id        = 'mode-btn-row';
  modeBtnRow.className = 'vp-action-row';
  // membrane-sketch.js's _buildModeButtons() populates this container.
  panel.appendChild(modeBtnRow);
}

// ---------------------------------------------------------------------------
// _buildMembraneSoundTab -- populate #vp-tab-sound for the membrane world.
//
// Contains the mode energy chart canvas. The chart is drawn by
// membrane-sketch.js's _drawModeEnergy() which gets a 2D context from
// the canvas element by ID. We just need to create the element here.
// ---------------------------------------------------------------------------
function _buildMembraneSoundTab() {
  const panel = document.getElementById('vp-tab-sound');
  if (!panel) return;
  panel.innerHTML = '';

  const hdr = document.createElement('div');
  hdr.className   = 'vp-ctrl-hdr';
  hdr.textContent = 'mode energies  (amber = degenerate pair)';
  panel.appendChild(hdr);

  const canvas = document.createElement('canvas');
  canvas.id     = 'mode-canvas';
  canvas.width  = 500;
  canvas.height = 120;
  canvas.style.cssText = 'display:block; background:#0d0d0d; border-radius:2px; max-width:100%;';
  panel.appendChild(canvas);
}

// ---------------------------------------------------------------------------
// _buildLatticeGeometryTab -- populate #vp-tab-geometry for the lattice world.
//
// Three axis-stiffness sliders, one per tonnetz coupling axis (fifth/third/minor).
// IDs use the lattice-sketch.js convention: k-fifth (input), kv-fifth (span).
// The lattice-sketch.js _syncSliders() function reads/writes these same IDs
// so preset application keeps sliders in sync without any extra wiring.
// ---------------------------------------------------------------------------
function _buildLatticeGeometryTab() {
  const panel = document.getElementById('vp-tab-geometry');
  if (!panel) return;
  panel.innerHTML = '';

  // ---- Shell count ----
  const shellHdr = document.createElement('div');
  shellHdr.className   = 'vp-ctrl-hdr';
  shellHdr.textContent = 'shells';
  panel.appendChild(shellHdr);

  const shellRow = document.createElement('div');
  shellRow.className = 'vp-action-row';

  const shellDefs = [
    { id: 'shell-btn-1', label: '1  (7 nodes)',  shells: 1 },
    { id: 'shell-btn-2', label: '2  (19 nodes)', shells: 2 },
    { id: 'shell-btn-3', label: '3  (37 nodes)', shells: 3 }
  ];
  for (const sd of shellDefs) {
    const btn = document.createElement('button');
    btn.id          = sd.id;
    btn.className   = 'vp-act-btn' + (sd.shells === 2 ? ' active' : '');
    btn.textContent = sd.label;
    btn.title       = 'Rebuild lattice with ' + sd.shells + ' shell(s)';
    btn.addEventListener('click', function() {
      if (window.vpApplyShells) window.vpApplyShells(sd.shells);
    });
    shellRow.appendChild(btn);
  }
  panel.appendChild(shellRow);

  // ---- Axis stiffness ----
  const hdr = document.createElement('div');
  hdr.className   = 'vp-ctrl-hdr';
  hdr.textContent = 'axis stiffness';
  panel.appendChild(hdr);

  // One slider row per tonnetz axis.
  // Colors match the axis legend in the original lattice.html.
  const axes = [
    { key: 'fifth', label: 'fifth', color: '#7af' },
    { key: 'third', label: 'third', color: '#af7' },
    { key: 'minor', label: 'minor', color: '#a7f' }
  ];

  for (const ax of axes) {
    const row = document.createElement('div');
    row.className = 'vp-ctrl-row';

    const lbl = document.createElement('span');
    lbl.className   = 'lbl';
    lbl.textContent = ax.label;
    lbl.style.color = ax.color;

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.id    = 'k-' + ax.key;   // matches lattice-sketch.js _syncSliders() lookup
    slider.min   = 0;
    slider.max   = 2000;
    slider.step  = 1;
    slider.value = 150;
    slider.setAttribute('aria-label', ax.label + ' axis stiffness');

    const valEl = document.createElement('span');
    valEl.className   = 'val';
    valEl.id          = 'kv-' + ax.key;   // matches lattice-sketch.js _syncSliders()
    valEl.textContent = '150';

    // Idle tracking: _latticeSyncUI skips this slider while the user is dragging.
    slider._isDragging = false;
    slider.addEventListener('pointerdown', () => { slider._isDragging = true;  });
    slider.addEventListener('pointerup',   () => { slider._isDragging = false; });
    slider.addEventListener('blur',        () => { slider._isDragging = false; });

    // Live update: call lattice-sketch.js onAxisSlider() on every drag tick.
    const axKey = ax.key;  // capture for closure
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      valEl.textContent = Math.round(v);
      if (window.onAxisSlider) window.onAxisSlider(axKey, v);
    });

    row.appendChild(lbl);
    row.appendChild(slider);
    row.appendChild(valEl);
    panel.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// _buildLatticePhysicsExtras -- append lattice-specific controls to #vp-tab-physics.
//
// Adds a container for mode-shape buttons. Buttons themselves are injected by
// lattice-sketch.js _buildModeButtons() in setup() (after vpBuildMenu returns).
// ---------------------------------------------------------------------------
function _buildLatticePhysicsExtras() {
  const panel = document.getElementById('vp-tab-physics');
  if (!panel) return;

  const hdr = document.createElement('div');
  hdr.className   = 'vp-ctrl-hdr';
  hdr.textContent = 'mode shapes';
  panel.appendChild(hdr);

  const modeRow = document.createElement('div');
  modeRow.id        = 'mode-btn-row';
  modeRow.className = 'vp-action-row';
  panel.appendChild(modeRow);

  // Frequency list: one line per mode, populated by _latticeSyncUI() when
  // the mode count changes (i.e. when shell count changes).
  const freqList = document.createElement('div');
  freqList.id        = 'lattice-freq-list';
  freqList.className = 'vp-freq-list';
  panel.appendChild(freqList);
}

// ---------------------------------------------------------------------------
// _buildLatticeSoundTab -- populate #vp-tab-sound for the lattice world.
//
// Creates the mode energy chart canvas (300 x 114 px).
// The chart is drawn each frame by lattice-sketch.js _drawModeEnergy().
// ---------------------------------------------------------------------------
function _buildLatticeSoundTab() {
  const panel = document.getElementById('vp-tab-sound');
  if (!panel) return;
  panel.innerHTML = '';

  // ---- Tuning toggle ----
  const tuningHdr = document.createElement('div');
  tuningHdr.className   = 'vp-ctrl-hdr';
  tuningHdr.textContent = 'tuning  (T key)';
  panel.appendChild(tuningHdr);

  const tuningRow = document.createElement('div');
  tuningRow.className = 'vp-action-row';

  const tuningBtn = document.createElement('button');
  tuningBtn.id          = 'btn-tuning-toggle';
  tuningBtn.className   = 'vp-act-btn';
  tuningBtn.textContent = 'just';           // updated by _latticeSyncUI each frame
  tuningBtn.title       = 'Toggle between 5-limit just intonation and 12-TET (T key)';
  tuningBtn.addEventListener('click', () => {
    if (window.vpToggleTuning) window.vpToggleTuning();
  });
  tuningRow.appendChild(tuningBtn);
  panel.appendChild(tuningRow);

  // ---- Mode energies chart ----
  const hdr = document.createElement('div');
  hdr.className   = 'vp-ctrl-hdr';
  hdr.textContent = 'mode energies';
  panel.appendChild(hdr);

  const canvas = document.createElement('canvas');
  canvas.id     = 'mode-canvas';
  canvas.width  = 300;
  canvas.height = 114;
  canvas.style.cssText = 'display:block; background:#0d0d0d; border-radius:2px; max-width:100%;';
  panel.appendChild(canvas);
}

// ---------------------------------------------------------------------------
// _latticeSyncUI -- per-frame sync for the lattice world.
//
// Syncs the three axis-stiffness sliders from VP_STATE.kFifth/kThird/kMinor.
// Uses _isDragging guards (set in _buildLatticeGeometryTab) so the slider
// is not overwritten while the user is actively dragging it.
//
// @param {Object} state -- window.VP_STATE from lattice-sketch.js draw()
// ---------------------------------------------------------------------------
let _prevLatticeModeCount = -1;

function _latticeSyncUI(state) {
  // Helper: sync one axis slider by its specific slider/val element IDs.
  function syncAxis(sliderId, valId, value) {
    const el = document.getElementById(sliderId);
    if (!el || el._isDragging) return;
    el.value = value;
    const valEl = document.getElementById(valId);
    if (valEl) valEl.textContent = Math.round(value);
  }
  if (state.kFifth !== undefined) syncAxis('k-fifth', 'kv-fifth', state.kFifth);
  if (state.kThird !== undefined) syncAxis('k-third', 'kv-third', state.kThird);
  if (state.kMinor !== undefined) syncAxis('k-minor', 'kv-minor', state.kMinor);

  // Highlight the shell button matching the current shell count.
  if (state.shells !== undefined) {
    for (let n = 1; n <= 3; n++) {
      const btn = document.getElementById('shell-btn-' + n);
      if (btn) btn.classList.toggle('active', n === state.shells);
    }
  }

  // Sync tuning toggle button label and active state.
  // 'just' = JI (default, no active highlight); '12-TET' = ET (active highlight).
  if (state.tuningMode !== undefined) {
    const tuningBtn = document.getElementById('btn-tuning-toggle');
    if (tuningBtn) {
      const isET = (state.tuningMode === 'et');
      tuningBtn.textContent = isET ? '12-TET' : 'just';
      tuningBtn.classList.toggle('active', isET);
    }
  }

  // Rebuild the flyout mode grid and Physics-tab freq list when shell count changes.
  // latticeModeCount = total eigenmodes; changes from 7 -> 19 -> 37 as shells increase.
  const N = state.latticeModeCount || 0;
  if (N !== _prevLatticeModeCount) {
    _rebuildFlyoutLatticeModeButtons(N);

    // Update the frequency list in the Physics tab.
    const freqListEl = document.getElementById('lattice-freq-list');
    if (freqListEl) {
      const freqs = state.latticeFreqs || [];
      freqListEl.textContent = freqs.map((hz, n) =>
        String(n + 1).padStart(2) + '  ' + hz.toFixed(1) + ' Hz'
      ).join('\n');
    }

    _prevLatticeModeCount = N;
  }
}

// ---------------------------------------------------------------------------
// _buildBeamPhysicsExtras -- append beam-specific controls to #vp-tab-physics.
//
// Appended after the universal speed/damp/slope sliders from _buildPhysicsTab().
// Adds: material preset buttons, end-strike toggle, display action buttons.
// Event listeners are attached later by beam-sketch.js _buildUI().
// ---------------------------------------------------------------------------
function _buildBeamPhysicsExtras() {
  const panel = document.getElementById('vp-tab-physics');
  if (!panel) return;

  // ---- Material section ----
  const matHdr = document.createElement('div');
  matHdr.className   = 'vp-ctrl-hdr';
  matHdr.textContent = 'material';
  panel.appendChild(matHdr);

  const matRow = document.createElement('div');
  matRow.className = 'vp-action-row';

  const matDefs = [
    { id: 'mat-metal', label: 'metal', title: 'Metal: reference stiffness, moderate damping' },
    { id: 'mat-glass', label: 'glass', title: 'Glass: 4x stiffer, one octave higher, very low damping' },
    { id: 'mat-wood',  label: 'wood',  title: 'Wood: 1/4 stiffness, one octave lower, fast decay' }
  ];
  for (const d of matDefs) {
    const btn = document.createElement('button');
    btn.id        = d.id;
    btn.className = 'vp-act-btn' + (d.id === 'mat-metal' ? ' active' : '');
    btn.textContent = d.label;
    btn.title       = d.title;
    matRow.appendChild(btn);
  }
  panel.appendChild(matRow);

  // ---- End-strike / display section ----
  const dispHdr = document.createElement('div');
  dispHdr.className   = 'vp-ctrl-hdr';
  dispHdr.textContent = 'display & actions';
  panel.appendChild(dispHdr);

  const dispRow = document.createElement('div');
  dispRow.className = 'vp-action-row';

  const dispDefs = [
    { id: 'end-strike-btn', label: 'end: off',     title: 'Toggle extensional (end) strike mode (E key)' },
    { id: 'color-btn',      label: 'color: off',   title: 'Toggle displacement color mode (C key)'       },
    { id: 'surface-btn',    label: 'surface: off', title: 'Toggle solid surface mode (F key)'             },
    { id: 'freeze-btn',     label: 'freeze',       title: 'Freeze / unfreeze physics (Space)'             },
    { id: 'zero-btn',       label: 'zero',         title: 'Zero all displacement and velocity (Z key)'    },
    { id: 'reset-btn',      label: 'reset',        title: 'Reset beam to center strike (R key)'           }
  ];
  for (const d of dispDefs) {
    const btn = document.createElement('button');
    btn.id          = d.id;
    btn.className   = 'vp-act-btn';
    btn.textContent = d.label;
    btn.title       = d.title;
    dispRow.appendChild(btn);
  }
  panel.appendChild(dispRow);

  // ---- Frequency readout ----
  // beam-sketch.js writes formatted text into this div each frame via
  // document.getElementById('freq-display').innerHTML = ...
  const freqDisplay = document.createElement('div');
  freqDisplay.id         = 'freq-display';
  freqDisplay.style.cssText = 'margin-top:8px; padding:7px 10px; background:#141414; border:1px solid #2a2a2a; border-radius:3px; font-size:12px; line-height:1.7; color:#888; font-family:\'IBM Plex Mono\',\'SF Mono\',\'Fira Mono\',monospace;';
  panel.appendChild(freqDisplay);
}

// ---------------------------------------------------------------------------
// _buildBeamGeometryTab -- populate #vp-tab-geometry for the beam world.
//
// Adds: beam length slider, cross-section type selector, and per-type param sliders.
// Event listeners are attached by beam-sketch.js _buildUI() via element IDs.
// ---------------------------------------------------------------------------
function _buildBeamGeometryTab() {
  const panel = document.getElementById('vp-tab-geometry');
  if (!panel) return;
  panel.innerHTML = '';

  // ---- Beam length ----
  const lenHdr = document.createElement('div');
  lenHdr.className   = 'vp-ctrl-hdr';
  lenHdr.textContent = 'beam length';
  panel.appendChild(lenHdr);

  const lenRow = document.createElement('div');
  lenRow.className = 'vp-ctrl-row';

  const lenLbl = document.createElement('span');
  lenLbl.className   = 'lbl';
  lenLbl.textContent = 'L (m)';

  const lenSlider = document.createElement('input');
  lenSlider.type  = 'range';
  lenSlider.id    = 'length-slider';
  lenSlider.min   = 0.4;
  lenSlider.max   = 2.0;
  lenSlider.step  = 0.05;
  lenSlider.value = 1.0;

  const lenValEl = document.createElement('span');
  lenValEl.className   = 'val';
  lenValEl.id          = 'length-label';
  lenValEl.textContent = '1.00 m';

  lenRow.appendChild(lenLbl);
  lenRow.appendChild(lenSlider);
  lenRow.appendChild(lenValEl);
  panel.appendChild(lenRow);

  // ---- Cross-section ----
  const csHdr = document.createElement('div');
  csHdr.className   = 'vp-ctrl-hdr';
  csHdr.textContent = 'cross-section';
  panel.appendChild(csHdr);

  const csTypeRow = document.createElement('div');
  csTypeRow.className = 'vp-action-row';

  const csTypes = [
    { id: 'cs-square', label: 'square', active: true  },
    { id: 'cs-circle', label: 'circle', active: false },
    { id: 'cs-tube',   label: 'tube',   active: false },
    { id: 'cs-rect',   label: 'rect',   active: false }
  ];
  for (const t of csTypes) {
    const btn = document.createElement('button');
    btn.id          = t.id;
    btn.className   = 'vp-act-btn' + (t.active ? ' active' : '');
    btn.textContent = t.label;
    csTypeRow.appendChild(btn);
  }
  panel.appendChild(csTypeRow);

  // Helper: build a slider row for a CS parameter.
  function _csParamRow(groupId, rows) {
    const div = document.createElement('div');
    div.id    = groupId;
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'vp-ctrl-row';
      row.style.marginTop = '4px';

      const lbl = document.createElement('span');
      lbl.className   = 'lbl';
      lbl.textContent = r.label;

      const sl = document.createElement('input');
      sl.type  = 'range';
      sl.id    = r.id;
      sl.min   = r.min;
      sl.max   = r.max;
      sl.step  = r.step;
      sl.value = r.value;

      const valEl = document.createElement('span');
      valEl.className   = 'val';
      valEl.id          = r.valId;
      valEl.textContent = r.value + ' mm';

      row.appendChild(lbl);
      row.appendChild(sl);
      row.appendChild(valEl);
      div.appendChild(row);
    }
    return div;
  }

  // Square params
  panel.appendChild(_csParamRow('cs-params-square', [
    { id: 'cs-h', valId: 'cs-h-label', label: 'h', min: 5, max: 50, step: 1, value: 20 }
  ]));

  // Circle params (hidden by default)
  const circleDiv = _csParamRow('cs-params-circle', [
    { id: 'cs-r', valId: 'cs-r-label', label: 'r', min: 5, max: 25, step: 1, value: 10 }
  ]);
  circleDiv.style.display = 'none';
  panel.appendChild(circleDiv);

  // Tube params (hidden by default)
  const tubeDiv = _csParamRow('cs-params-tube', [
    { id: 'cs-ro',   valId: 'cs-ro-label',   label: 'r-outer', min: 5, max: 25, step: 1, value: 12 },
    { id: 'cs-wall', valId: 'cs-wall-label', label: 'wall',    min: 1, max: 12, step: 1, value: 3  }
  ]);
  tubeDiv.style.display = 'none';
  panel.appendChild(tubeDiv);

  // Rect params (hidden by default)
  const rectDiv = _csParamRow('cs-params-rect', [
    { id: 'cs-width', valId: 'cs-width-label', label: 'width', min: 5, max: 50, step: 1, value: 20 },
    { id: 'cs-depth', valId: 'cs-depth-label', label: 'depth', min: 5, max: 50, step: 1, value: 20 }
  ]);
  rectDiv.style.display = 'none';
  panel.appendChild(rectDiv);

  // ---- Taper profile ----
  // The taper canvas is fixed at 900 logical pixels wide -- _setupTaperEditor
  // uses canvas.width for coordinate math and getBoundingClientRect() for
  // mouse hit-testing.  Wrapping in overflow-x:auto lets it scroll inside the
  // tab without distorting the coordinate system.
  const taperHdr = document.createElement('div');
  taperHdr.className   = 'vp-ctrl-hdr';
  taperHdr.textContent = 'taper profile';
  panel.appendChild(taperHdr);

  // Preset buttons row: uniform, barrel, waist, marimba, asym
  const taperPresetRow = document.createElement('div');
  taperPresetRow.className = 'vp-action-row';
  const taperPresets = [
    { id: 'taper-uniform', label: 'uniform' },
    { id: 'taper-barrel',  label: 'barrel'  },
    { id: 'taper-waist',   label: 'waist'   },
    { id: 'taper-marimba', label: 'marimba' },
    { id: 'taper-asym',    label: 'asym'    }
  ];
  for (const tp of taperPresets) {
    const btn = document.createElement('button');
    btn.id          = tp.id;
    btn.className   = 'vp-act-btn';
    btn.textContent = tp.label;
    taperPresetRow.appendChild(btn);
  }
  panel.appendChild(taperPresetRow);

  // Scrollable wrapper so the 900-wide canvas does not overflow the tab panel.
  const taperScroll = document.createElement('div');
  taperScroll.style.overflowX = 'auto';
  taperScroll.style.marginTop = '4px';

  const taperCanvas = document.createElement('canvas');
  taperCanvas.id     = 'taper-canvas';
  taperCanvas.width  = 900;
  taperCanvas.height = 80;
  taperCanvas.style.cssText = 'display:block; background:#141414; border:1px solid #2a2a2a; border-radius:3px; cursor:ns-resize;';

  taperScroll.appendChild(taperCanvas);
  panel.appendChild(taperScroll);

  const taperHint = document.createElement('div');
  taperHint.style.cssText = 'color:#444; font-size:10px; margin-top:3px; font-family:\'IBM Plex Mono\',\'SF Mono\',\'Fira Mono\',monospace;';
  taperHint.textContent = 'drag control points up/down \u2013 scale range 0.3\u20132.0';
  panel.appendChild(taperHint);
}

// ---------------------------------------------------------------------------
// _buildBeamSoundTab -- populate #vp-tab-sound for the beam world.
//
// Contains the mute button. The mute action is also on the sidebar, but the
// in-tab button is wired by beam-sketch.js _buildUI() and synced independently.
// ---------------------------------------------------------------------------
function _buildBeamSoundTab() {
  const panel = document.getElementById('vp-tab-sound');
  if (!panel) return;
  panel.innerHTML = '';

  const hdr = document.createElement('div');
  hdr.className   = 'vp-ctrl-hdr';
  hdr.textContent = 'sound';
  panel.appendChild(hdr);

  const muteRow = document.createElement('div');
  muteRow.className = 'vp-action-row';

  const muteBtn = document.createElement('button');
  muteBtn.id          = 'mute-btn';
  muteBtn.className   = 'vp-act-btn';
  muteBtn.textContent = 'mute: off';
  muteBtn.title       = 'Toggle mute (M key) -- click beam first to start audio';
  muteRow.appendChild(muteBtn);
  panel.appendChild(muteRow);
}

// ---------------------------------------------------------------------------
// _wireKeyboard -- register a single document keydown listener for Menu.js.
//
// Handles:
//   Escape -- close the scenarios flyout if open, or collapse the active tab.
//             World-specific keys (Space, R, M, etc.) are handled by each
//             sketch's own keyPressed() and are not intercepted here.
// ---------------------------------------------------------------------------
function _wireKeyboard() {
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;

    // Close flyout first; if it was already closed, collapse the active tab.
    const flyout = document.getElementById('vp-scenes-flyout');
    if (flyout && flyout.classList.contains('open')) {
      flyout.classList.remove('open');
      _flyoutPinned = false;
      const scenesBtn = document.getElementById('tool-scenes');
      if (scenesBtn) {
        scenesBtn.setAttribute('aria-expanded', 'false');
        scenesBtn.focus();   // return focus to the button that opened the flyout
      }
    } else if (_activeTab !== null) {
      _closeAllTabs();
    }
  });
}

// ---------------------------------------------------------------------------
// _init -- auto-called on DOMContentLoaded.
//
// Builds the sidebar and tab shell immediately so the page layout is correct
// before sketch.js runs its setup(). The sketch then calls vpBuildMenu() to
// inject world-specific content into the empty tab panels.
// ---------------------------------------------------------------------------
function _init() {
  _buildSidebar();
  _buildTabShell();
  _buildPhysicsTab();   // Step 2: populate Physics tab with universal controls
  _wireA11yToggle();
  // Wire helper toggle button in nav bar. HelperMode.js must be loaded first
  // (it comes before Menu.js in the HTML script-tag order).
  if (window.vpHelper) window.vpHelper.wireToggle();
  if (window.vpHelper) window.vpHelper.wireTooltips();
  _wireKeyboard();      // Step 8: Escape closes flyout / collapses tab
  _startPollLoop();     // Step 2: begin rAF sync loop
}

// ---------------------------------------------------------------------------
// window.vpBuildMenu -- public API called by each world's sketch in setup().
//
// In Step 1 this function accepts a config object but does not yet use it for
// tab content -- that comes in Steps 2 and 3. The sidebar and tabs are already
// built by _init(); vpBuildMenu() here just stores the config for future steps
// and updates the Hold button disabled state for the current world.
//
// @param {Object} config -- world configuration (format defined in menu-plan.md)
//   config.world          {string}  -- world identifier ('mass', 'string', ...)
//   config.tools.hold     {boolean} -- true = hold available; false = grayed out
// ---------------------------------------------------------------------------
window.vpBuildMenu = function(config) {
  _worldConfig = config;

  // Update Hold button disabled state for this world.
  // Worlds without hold support (lattice, membrane) pass tools.hold = false.
  const holdBtn = document.getElementById('tool-hold');
  if (holdBtn && config.tools) {
    const holdAvailable = config.tools.hold !== false;
    if (holdAvailable) {
      holdBtn.removeAttribute('aria-disabled');
      holdBtn.style.opacity = '';
      holdBtn.style.pointerEvents = '';
    } else {
      holdBtn.setAttribute('aria-disabled', 'true');
    }
  }

  // Populate the scenarios flyout from config.scenarios + window.VP_SCENARIOS.
  _buildScenesForWorld(config);

  // Build world-specific tab content and assign the per-frame sync function.
  if (config.world === 'mass') {
    _buildMassGeometryTab();      // Geometry tab: add/remove, group actions, mass rows
    _buildMassPhysicsExtras();    // Physics tab: forcing + mode shape buttons
    _buildMassSoundTab();         // Sound tab: detune, root pitch
    // syncUI is called by _poll() every frame with the current VP_STATE.
    _worldConfig.syncUI = _massSyncUI;
    // Reset topology tracking so first poll tick triggers full build.
    _prevNMasses = -1;
    _prevNFree   = -1;

  } else if (config.world === 'membrane') {
    _buildMembraneGeometryTab();   // Geometry tab: aspect ratio, BC indicators
    _buildMembranePhysicsExtras(); // Physics tab: tension, drive, mode shapes
    _buildMembraneSoundTab();      // Sound tab: mode energy chart
    // Assign per-frame sync: syncs membrane-specific sliders and drive button.
    _worldConfig.syncUI = _membraneSyncUI;
    // Note: _buildModeButtons() and modeCanvasCtx acquisition are called by
    // membrane-sketch.js setup() immediately AFTER vpBuildMenu() returns,
    // so the containers created above are available at that point.

  } else if (config.world === 'lattice') {
    _buildLatticeGeometryTab();    // Geometry tab: axis stiffness sliders
    _buildLatticePhysicsExtras();  // Physics tab: mode shapes container
    _buildLatticeSoundTab();       // Sound tab: mode energy chart canvas
    _worldConfig.syncUI = _latticeSyncUI;
    // Note: _buildModeButtons() is called by lattice-sketch.js setup() immediately
    // AFTER vpBuildMenu() returns, so #mode-btn-row exists at that point.

  } else if (config.world === 'strings') {
    _buildStringPhysicsExtras();         // Physics tab: Fourier + modal energy checkboxes
    _worldConfig.syncUI = _stringSyncUI; // per-frame sync: show/hide mode grid, update titles

  } else if (config.world === 'beam') {
    _buildBeamGeometryTab();    // Geometry tab: length slider + cross-section
    _buildBeamPhysicsExtras();  // Physics tab: material + display buttons
    _buildBeamSoundTab();       // Sound tab: mute button
    // No per-frame syncUI needed: beam-sketch.js manages its own button states
    // via _updateToolButtons() and keyPressed() handlers.
  }
};

// ---------------------------------------------------------------------------
// _stringSyncUI -- per-frame sync for the strings world.
//
// Called by _poll() via _worldConfig.syncUI each frame with VP_STATE.
// Two duties:
//   1. Show/gray the Mode Shapes section in the flyout based on stringCount.
//      Single string: full opacity, buttons enabled.
//      Multi-string: 40% opacity, buttons disabled (vpLaunchStringMode no-ops anyway).
//   2. Update title tooltips on the 16 mode buttons with current Hz values
//      (boundary-condition toggles change frequencies without changing count).
//
// @param {Object} state -- VP_STATE snapshot from 2D-sketch.js draw()
// ---------------------------------------------------------------------------
function _stringSyncUI(state) {
  const isSingle = !!(state && state.stringCount === 1);
  const opacity  = isSingle ? '1' : '0.4';

  // Sync tension slider readout to current string tension (single string only).
  // _syncSliderIfIdle guards against overwriting the slider while the user drags it.
  if (isSingle && state.stringTension !== undefined) {
    _syncSliderIfIdle('slider-string-tension', state.stringTension, v => Math.round(v));
  }

  // Gray/enable the flyout mode-shapes section.
  const hdr  = document.getElementById('string-mode-hdr');
  const grid = document.getElementById('flyout-string-mode-grid');
  if (hdr)  hdr.style.opacity  = opacity;
  if (grid) grid.style.opacity = opacity;

  // Gray/enable the Physics tab mode-shapes section and frequency list.
  const physModeHdr  = document.getElementById('string-physics-mode-hdr');
  const physModeRow  = document.getElementById('string-physics-mode-row');
  const physFreqList = document.getElementById('string-freq-list');
  if (physModeHdr)  physModeHdr.style.opacity  = opacity;
  if (physModeRow)  physModeRow.style.opacity   = opacity;
  if (physFreqList) physFreqList.style.opacity  = opacity;

  // Update mode button titles with current frequencies (flyout + Physics tab).
  // Both grids share the same dataset.mode attribute and vp-flyout-mode-btn class.
  const freqs = (state && state.stringFreqs) || [];
  for (const container of [grid, physModeRow]) {
    if (!container) continue;
    const btns = container.querySelectorAll('.vp-flyout-mode-btn');
    btns.forEach((btn) => {
      const n   = parseInt(btn.dataset.mode, 10);
      const hz  = freqs[n];
      btn.title    = 'Mode ' + (n + 1) + (hz !== undefined ? '  \u2014  ' + hz.toFixed(2) + ' Hz' : '');
      btn.disabled = !isSingle;
    });
  }

  // Populate the frequency list below the Physics tab mode buttons.
  // Two columns: "Visible" (physics frequency) and "Audible" (KS synth pitch).
  // StringSoundObserver.AUDIO_SCALE = 100: the physics runs 100x slower than
  // real time so wave motion is visible; multiplying by 100 gives the heard pitch.
  if (physFreqList) {
    if (isSingle && freqs.length > 0) {
      const AUDIO_SCALE = 100;
      // Header: aligned to the two data columns below it.
      // Data format: "{n:3}  {viz:6} Hz  {aud:5} Hz"
      //   visible column starts at char 5, audible at char 16.
      const header = '     visible    audible';
      const lines = freqs.map((hz, n) => {
        const viz = hz.toFixed(1).padStart(6);                          // e.g. "   2.2"
        const aud = Math.round(hz * AUDIO_SCALE).toString().padStart(5); // e.g. "  220"
        return String(n + 1).padStart(3) + '  ' + viz + ' Hz  ' + aud + ' Hz';
      });
      physFreqList.textContent = [header, ...lines].join('\n');
    } else {
      physFreqList.textContent = '';
    }
  }
}

// ---------------------------------------------------------------------------
// _buildStringPhysicsExtras -- append string-world controls to #vp-tab-physics.
//
// Adds:
//   Tension section:
//     tension slider (N) -- calls vpSetStringTension(value) live
//   Overlays section:
//     fourier series checkbox -- enables VP_OVERLAYS.fourier (single string only)
//     modal energy checkbox   -- enables VP_OVERLAYS.modalEnergy (single string only)
//
// Also defines window.syncFourierControls(), called each frame by 2D-sketch.js
// to gray the overlay checkboxes when multi-string mode is active.
// ---------------------------------------------------------------------------
function _buildStringPhysicsExtras() {
  const panel = document.getElementById('vp-tab-physics');
  if (!panel) return;

  // ---- Tension section ----
  const tensionHdr = document.createElement('div');
  tensionHdr.className   = 'vp-ctrl-hdr';
  tensionHdr.textContent = 'tension';
  panel.appendChild(tensionHdr);

  // Range: 10 N (very slack) to 400 N (very tight).
  // Default 97 N matches StringDefinition.js constructor default,
  // giving c = sqrt(97/5) = 4.4 m/s for density = 5 kg/m.
  panel.appendChild(_makeSliderRow({
    id:       'slider-string-tension',
    label:    'T (N)',
    min:      10,
    max:      400,
    step:     1,
    value:    97,
    fmtFn:    v => Math.round(v),
    onChange: v => { if (window.vpSetStringTension) window.vpSetStringTension(v); }
  }));

  // ---- Hammer width section ----
  const hammerHdr = document.createElement('div');
  hammerHdr.className   = 'vp-ctrl-hdr';
  hammerHdr.textContent = 'strike';
  panel.appendChild(hammerHdr);

  // Range: 1% to 50% of string length.
  // Default 5% matches the hardcoded value in StringInteractionController constructor.
  // Narrow hammer: bright, harmonically rich (many modes excited).
  // Wide hammer: dull tone (high modes suppressed -- sin(n*pi*hw/L) --> 0 for n >> L/hw).
  panel.appendChild(_makeSliderRow({
    id:       'slider-hammer-width',
    label:    'hammer width',
    min:      0.01,
    max:      0.50,
    step:     0.01,
    value:    0.05,
    fmtFn:    v => Math.round(v * 100) + '%',
    onChange: v => { if (window.vpSetHammerWidth) window.vpSetHammerWidth(v); }
  }));

  // ---- Overlays section ----
  const ovlHdr = document.createElement('div');
  ovlHdr.className   = 'vp-ctrl-hdr';
  ovlHdr.textContent = 'overlays';
  panel.appendChild(ovlHdr);

  // Helper: one checkbox row wired to VP_OVERLAYS[key].
  // Returns { row, cb } so the caller can add IDs / listeners.
  function _addStringOverlay(rowId, cbId, labelTxt, ovlKey) {
    const row = document.createElement('div');
    row.className = 'vp-check-row';
    row.id        = rowId;
    const lbl = document.createElement('label');
    const cb  = document.createElement('input');
    cb.type = 'checkbox';
    cb.id   = cbId;
    cb.addEventListener('change', function () {
      if (!window.VP_OVERLAYS) window.VP_OVERLAYS = {};
      window.VP_OVERLAYS[ovlKey] = this.checked;
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + labelTxt));
    row.appendChild(lbl);
    panel.appendChild(row);
    return { row, cb };
  }

  // Fourier series checkbox -- single string only.
  _addStringOverlay('fourier-check-row', 'ovl-fourier', 'fourier series', 'fourier');

  // Modal energy overlay checkbox -- single string only.
  _addStringOverlay('string-modal-energy-row', 'ovl-string-modal-energy',
                    'modal energy', 'modalEnergy');

  // syncFourierControls -- called every draw frame by 2D-sketch.js.
  // Grays both single-string overlays when multi-string is active.
  window.syncFourierControls = function () {
    const state    = window.VP_STATE;
    const isSingle = !!(state && state.world === 'strings' && state.stringCount === 1);
    for (const id of ['fourier-check-row', 'string-modal-energy-row']) {
      const el = document.getElementById(id);
      if (el) el.style.opacity = isSingle ? '1' : '0.4';
    }
    for (const id of ['ovl-fourier', 'ovl-string-modal-energy']) {
      const cb = document.getElementById(id);
      if (cb) cb.disabled = !isSingle;
    }
  };

  // ---- Mode shapes section ----
  // Fixed 16 modes for all string configurations; grayed when multi-string.
  // Clicking a button calls vpLaunchStringMode(n) which sets the string to
  // pure standing-wave mode n (0-based) and drops damping so the mode rings.
  const modeHdr = document.createElement('div');
  modeHdr.id        = 'string-physics-mode-hdr';
  modeHdr.className = 'vp-ctrl-hdr';
  modeHdr.textContent = 'mode shapes';
  panel.appendChild(modeHdr);

  const modeRow = document.createElement('div');
  modeRow.id        = 'string-physics-mode-row';
  modeRow.className = 'vp-action-row';
  panel.appendChild(modeRow);

  // Build all 16 buttons once -- mode count never changes for strings.
  // vp-flyout-mode-btn gives the compact square style matching the flyout grid.
  for (let n = 0; n < 16; n++) {
    const btn = document.createElement('button');
    btn.className    = 'vp-flyout-mode-btn';
    btn.textContent  = String(n + 1);  // 1-based label
    btn.dataset.mode = String(n);      // 0-based index for title updates
    btn.title        = 'Mode ' + (n + 1);
    const idx = n;   // capture for closure
    btn.addEventListener('click', () => {
      if (window.vpLaunchStringMode) window.vpLaunchStringMode(idx);
    });
    modeRow.appendChild(btn);
  }

  // Frequency list: one line per mode, populated by _stringSyncUI() each frame.
  // Grayed alongside the mode buttons when multi-string is active.
  const freqList = document.createElement('div');
  freqList.id        = 'string-freq-list';
  freqList.className = 'vp-freq-list';
  panel.appendChild(freqList);
}

// ---------------------------------------------------------------------------
// Auto-init on DOM ready.
// ---------------------------------------------------------------------------
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  // Document already parsed (e.g., script loaded at end of body).
  _init();
}
