/**
 * HelperMode.js
 *
 * Responsibility:
 *   Progressive, contextual hint system for all Vibration Playground worlds.
 *   Observes VP_STATE (read-only) and injects overlay UI to guide new users
 *   through each world's features in a logical sequence.
 *
 * NOT allowed to:
 *   Modify physics, modal state, or any observer.
 *   Call vpBuildMenu or touch the sidebar directly.
 *
 * -------------------------------------------------------------------
 * Architecture (see plan: twinkling-hatching-dove.md):
 *
 *   Nav.js      -- renders #btn-helper; wireToggle() attaches click handler
 *   Menu.js     -- calls vpHelper.wireTooltips() after sidebar build;
 *                  calls vpHelper.onStateUpdate(state) from _poll() each frame
 *   World sketches -- export lastAction + lastScenario in VP_STATE
 *
 * -------------------------------------------------------------------
 * Overlay elements (injected once into <body> at module load):
 *
 *   #vp-helper-tooltip  -- floating tooltip near hovered control
 *   #vp-helper-panel    -- persistent suggestion panel (fixed, bottom of sidebar)
 *
 * Both are hidden when helper mode is off (body.vp-helper absent).
 *
 * -------------------------------------------------------------------
 * Hint progression model:
 *
 *   HINTS[world] = array of hint objects, one per step:
 *   {
 *     text:    string   -- instructional text shown in the suggestion panel
 *     advance: function(state) -> boolean
 *                       -- called each poll frame; returns true when the user
 *                          has completed this step and the next hint should show
 *   }
 *
 *   _state.step advances when advance(state) returns true.
 *   Steps wrap: after the last hint, the sequence restarts at step 0.
 *   _state.world resets step to 0 when the world changes.
 *
 * -------------------------------------------------------------------
 * Tooltip content:
 *
 *   TOOLTIPS is a plain object keyed by element ID (or CSS class when prefixed
 *   with "."). Values are short helper strings. wireTooltips() registers
 *   mouseenter listeners on matching elements; the tooltip floats near the cursor.
 */

// =============================================================================
// HINT DATA -- world-specific progressive suggestion sequences.
// advance(state): receives the current VP_STATE snapshot and returns true when
// the user has completed this step.
// =============================================================================
const HINTS = {

  // ---------------------------------------------------------------------------
  // Mass world (mdof)
  // ---------------------------------------------------------------------------
  mdof: [
    {
      text: 'Drag a mass to displace it, then release -- watch it oscillate and decay.',
      advance: function(s) { return s.lastAction === 'drag'; }
    },
    {
      text: 'Click in the space between two masses to couple them together. Double-click to remove coupling.',
      advance: function(s) { return s.lastAction === 'couple'; }
    },
    {
      text: 'Open the SCENE panel and try "16 masses coupled". Test the different mode shapes by clicking on a mode shape number.',
      advance: function(s) { return s.nMasses >= 2; }
    },
    {
      text: 'Open the Physics tab and turn on mode shape analysis to see the different mode shapes of the system.',
      advance: function(s) { return s.nFree >= 1 && s.lastAction === 'strike'; }
    },
    {
      text: 'Switch to the Hold tool (H key or sidebar). Click a mass to pin it at zero. The modes that pass through zero at that point survive; others vanish from the spectrum.',
      advance: function(s) { return s.currentTool === 'hold'; }
    },
    {
      text: 'Press F to enable modal forcing. A sinusoidal force is applied at the natural frequency -- watch energy build up over cycles. This is resonance.',
      advance: function(s) { return !!s.modalForcingActive; }
    },
    {
      text: 'Open Scenarios > "absorber". The second mass is tuned to cancel vibration of the first at one frequency. Drag the absorber mass to detune it and watch energy re-enter the primary.',
      advance: function(s) { return s.lastScenario === 'absorber'; }
    }
  ],

  // ---------------------------------------------------------------------------
  // Single string (string)
  // ---------------------------------------------------------------------------
  string: [
    {
      text: 'Click anywhere on the string to pluck it. The triangular initial shape decomposes into harmonics.',
      advance: function(s) { return s.lastAction === 'strike' || s.lastAction === 'drag'; }
    },
    {
      text: 'Open the Physics tab and click mode 1 -- the fundamental. Then try mode 2. Notice the change in pitch and decay rate.',
      advance: function(s) { return s.lastAction === 'strike'; }
    },
    {
      text: 'Switch to the Hold tool (H). Click anywhere on the string to create a pin connection, then play the two strings and notice the difference in sound.',
      advance: function(s) { return s.currentTool === 'hold'; }
    },
    {
      text: 'Open the Physics tab and turn on the Fourier series overlay. Watch how the partial sums converge to the plucked shape.',
      advance: function(s) { return !!(window.VP_OVERLAYS && window.VP_OVERLAYS.fourier); }
    }
  ],

  // ---------------------------------------------------------------------------
  // Multi-string (strings)
  // ---------------------------------------------------------------------------
  strings: [
   
    {
      text: 'Using the STRUM tool, drag across the strings to play multiple strings at once.',
      advance: function(s) { return s.currentTool === 'strum'; }
    }
  ],

  // ---------------------------------------------------------------------------
  // Lattice world
  // ---------------------------------------------------------------------------
  lattice: [
    {
      text: 'Click any node to strike the lattice. Each node is a mass; edges are springs. The vibration travels outward as a 2D wave.',
      advance: function(s) { return s.lastAction === 'strike'; }
    },
    {
      text: 'Drag a node to change its mass. Heavier nodes vibrate more slowly and lower in pitch.',
      advance: function(s) { return s.lastAction === 'drag-mass'; }
    },
    {
      text: 'Drag an edge to change its stiffness. Stiffer springs raise the frequencies of the modes that use that connection.',
      advance: function(s) { return s.lastAction === 'drag-stiffness'; }
    },
    {
      text: 'Open SCENE > "fifth highway". Stiffness is concentrated along one axis, creating directional wave propagation -- waves travel fast along the stiff axis and slow across it.',
      advance: function(s) { return s.lastScenario === 'fifth-highway' || s.lastScenario === 'third-highway' || s.lastScenario === 'minor-highway'; }
    },
    {
      text: 'Open the Physics tab and click a mode shape button to isolate a single mode. Then try the adjacent degenerate mode (same frequency, rotated shape).',
      advance: function(s) { return s.lastAction === 'strike'; }
    }
  ],

  // ---------------------------------------------------------------------------
  // Membrane world
  // ---------------------------------------------------------------------------
  membrane: [
    {
      text: 'Click anywhere on the membrane to strike it. The wave spreads outward from the strike point.',
      advance: function(s) { return s.lastAction === 'strike'; }
    },
    {
      text: 'Try striking near a corner. Compare the timbre to a center strike -- corners excite all mode pairs (mx, my), while center strikes only excite modes with both indices odd.',
      advance: function(s) { return s.lastAction === 'strike'; }
    },
    {
      text: 'Click near an edge to toggle it between fixed (displacement = 0) and free (no constraint). Listen for the change in modal structure.',
      advance: function(s) { return s.lastAction === 'boundary'; }
    },
    {
      text: 'Open SCENE > "rectangle (1:1.5)". The aspect ratio breaks the square degeneracies: mode pairs like (2,1) and (1,2) split apart in frequency.',
      advance: function(s) { return s.lastScenario === 'rectangle' || s.lastScenario === 'wide'; }
    },
    {
      text: 'Open the Physics tab and click a mode shape button to excite a pure (mx, my) mode. Use the color wireframe checkbox to see positive and negative displacement zones.',
      advance: function(s) { return s.lastAction === 'strike'; }
    },
    {
      text: 'Open the Physics tab and enable harmonic drive. Select a mode, press Drive -- energy builds resonantly at that frequency. Watch the Chladni-like nodal pattern emerge.',
      advance: function(s) { return !!s.isDriveOn; }
    }
  ],

  // ---------------------------------------------------------------------------
  // Beam world
  // ---------------------------------------------------------------------------
  beam: [
    {
      text: 'Click anywhere on the beam to strike it in bending. The beam flexes as a superposition of Euler-Bernoulli bending modes.',
      advance: function(s) { return s.lastAction === 'strike_bending'; }
    },
    {
      text: 'Open the Geometry tab. Drag the taper profile to create a non-uniform beam. The mode shapes and frequencies update in real time.',
      advance: function(s) { return s.lastAction === 'strike_bending' || s.lastAction === 'strike_extensional'; }
    }
  ]
};

// =============================================================================
// TOOLTIPS -- short help text for UI controls, keyed by element ID.
// Shown when helper mode is on and the mouse hovers over the element.
// =============================================================================
const TOOLTIPS = {
  // Sidebar tool buttons
  'tool-pointer':    'Move tool: click the canvas to deliver a velocity impulse at that point.',
  'tool-hold':       'Hold tool: click a point on the structure to pin it at zero displacement.',
  // Tab buttons (by data-tab attribute, handled in wireTooltips)
  'tab-geometry':    'Geometry: change the physical dimensions and shape of the structure.',
  'tab-physics':     'Physics: control damping, time scale, mode shapes, and driving.',
  'tab-sound':       'Sound: view modal energy and adjust audio parameters.',
  // Sidebar universal controls
  'slider-speed':    'Time scale: slow down physics to watch wave propagation in detail.',
  'slider-zeta':     'Damping ratio (zeta): how quickly energy decays. zeta=0.01 is lightly damped; zeta=0.1 damps fast.',
  'slider-slope-zeta': 'Damping slope: higher modes lose energy faster at high slope values.',
  // Scenarios button (general)
  'tool-scenarios':  'Scenarios: pre-configured starting points that demonstrate key physics concepts.',
  // Mute
  'tool-mute':       'Mute and Unmute sound.',
  // Contextual buttons
  'ctx-drive':       'Harmonic drive: apply a sinusoidal force at a normal mode frequency to build resonance.',
  'ctx-force':       'Modal forcing: excite a single mode harmonically.'
};

// =============================================================================
// Persistence helpers -- window.name storage.
//
// window.name is a string that survives navigation within the same browser tab.
// It is the only cross-page persistence mechanism that works reliably on the
// file:// protocol used by this project.
// localStorage/sessionStorage are prohibited (CLAUDE.md). Cookies are unreliable
// on file:// because each file path is treated as a separate cookie origin.
//
// Convention: the string '|vp_helper_off' is appended to window.name when the
// user explicitly turns helper mode off. Its absence means "on by default".
// =============================================================================
function _cookieIsOff() {
  try { return window.name.indexOf('vp_helper_off') !== -1; } catch(e) { return false; }
}

function _setCookieOff(isOff) {
  try {
    if (isOff) {
      // Append marker if not already present.
      if (window.name.indexOf('vp_helper_off') === -1) {
        window.name += '|vp_helper_off';
      }
    } else {
      // Remove marker (and any leading pipe) when re-enabling.
      window.name = window.name.replace(/\|?vp_helper_off/g, '');
    }
  } catch(e) {}
}

// =============================================================================
// Module state
// =============================================================================
var _helperState = {
  enabled:      false,
  world:        null,    // last world seen in VP_STATE; used to detect world transitions
  step:         0,       // current hint index within HINTS[world]
  _advanceLock: false    // prevent re-entry during a single poll frame
};

// One-shot DOM elements created by _buildOverlay().
var _tooltipEl = null;
var _panelEl   = null;

// =============================================================================
// _enable / _disable -- canonical on/off transitions.
//
// Both update _helperState, body class, window.name persistence marker, nav button
// active state, and tooltip visibility. All code paths that enable or disable
// helper mode must go through one of these rather than toggling directly.
// =============================================================================
function _enable() {
  _helperState.enabled = true;
  document.body.classList.add('vp-helper');
  _setCookieOff(false);
  _syncNavBtn(true);
  // If VP_STATE is already available (page already running), initialise world.
  var state = window.VP_STATE;
  if (state && state.world && !_helperState.world) {
    var hw = state.world;
    if (state.world === 'strings') hw = (state.stringCount === 1) ? 'string' : 'strings';
    _helperState.world = hw;
    _helperState.step  = 0;
    _updatePanel();
  }
}

function _disable() {
  _helperState.enabled = false;
  document.body.classList.remove('vp-helper');
  _setCookieOff(true);
  _syncNavBtn(false);
  _hideTooltip();
}

// _syncNavBtn -- keep the #btn-helper active class in sync with enabled state.
function _syncNavBtn(isOn) {
  var btn = document.getElementById('btn-helper');
  if (btn) btn.classList.toggle('active', isOn);
}

// =============================================================================
// _buildOverlay -- inject tooltip and suggestion panel elements.
//
// Tooltip: appended to <body> (absolute-positioned, floats near hovered elements).
// Panel:   appended to #canvas-container as a full-canvas transparent overlay.
//          Content is anchored to the bottom-left corner of the canvas.
//
// Called once at module load. Both start hidden; body.vp-helper reveals the panel.
// =============================================================================
function _buildOverlay() {

  // --- Tooltip: floats near hovered sidebar control ---
  _tooltipEl = document.createElement('div');
  _tooltipEl.id        = 'vp-helper-tooltip';
  _tooltipEl.className = 'vp-helper-tooltip';
  document.body.appendChild(_tooltipEl);

  // --- Suggestion panel: full-canvas overlay anchored bottom-left ---
  //
  // Outer div (#vp-helper-panel) fills the canvas container exactly.
  // pointer-events: none so orbit, click, and drag pass through to the canvas.
  //
  // Inner div (.vp-helper-content) is positioned at bottom-left and has
  // pointer-events: auto so its buttons remain clickable.
  _panelEl = document.createElement('div');
  _panelEl.id        = 'vp-helper-panel';
  _panelEl.className = 'vp-helper-panel';

  // Content box: lives in the bottom-left corner of the overlay.
  var content = document.createElement('div');
  content.className = 'vp-helper-content';

  // Step counter label: "Step 2 / 7"
  var stepLabel = document.createElement('span');
  stepLabel.id        = 'vp-helper-step';
  stepLabel.className = 'vp-helper-step-label';

  // Hint text paragraph.
  var hintText = document.createElement('span');
  hintText.id        = 'vp-helper-text';
  hintText.className = 'vp-helper-hint-text';

  // Button row: skip + turn off.
  var btnRow = document.createElement('div');
  btnRow.className = 'vp-helper-btn-row';

  var skipBtn = document.createElement('button');
  skipBtn.id          = 'vp-helper-skip';
  skipBtn.className   = 'vp-helper-action-btn';
  skipBtn.textContent = 'skip';
  skipBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    _advanceStep();
  });

  // "Turn Off Helper" permanently disables and remembers the choice via cookie.
  var offBtn = document.createElement('button');
  offBtn.id          = 'vp-helper-off-btn';
  offBtn.className   = 'vp-helper-action-btn vp-helper-off-btn';
  offBtn.textContent = 'turn off helper';
  offBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    _disable();
  });

  btnRow.appendChild(skipBtn);
  btnRow.appendChild(offBtn);

  content.appendChild(stepLabel);
  content.appendChild(hintText);
  content.appendChild(btnRow);
  _panelEl.appendChild(content);

  // Append to #canvas-container so the overlay tracks the canvas size/position.
  var canvasContainer = document.getElementById('canvas-container');
  if (canvasContainer) {
    canvasContainer.appendChild(_panelEl);
  } else {
    // Fallback: append to body if canvas-container not found.
    document.body.appendChild(_panelEl);
  }
}

// =============================================================================
// _updatePanel -- refresh the suggestion panel text for the current step.
// =============================================================================
function _updatePanel() {
  if (!_panelEl) return;

  var world = _helperState.world;
  var hints = world ? HINTS[world] : null;
  if (!hints || hints.length === 0) {
    // No hints for this world -- hide panel content but keep element in DOM.
    var stepEl = document.getElementById('vp-helper-step');
    var textEl = document.getElementById('vp-helper-text');
    if (stepEl) stepEl.textContent = '';
    if (textEl) textEl.textContent = 'Explore freely! No guided steps for this world.';
    return;
  }

  var step    = _helperState.step % hints.length;
  var hint    = hints[step];
  var stepEl  = document.getElementById('vp-helper-step');
  var textEl  = document.getElementById('vp-helper-text');

  if (stepEl) stepEl.textContent = 'Step ' + (step + 1) + ' / ' + hints.length;
  if (textEl) textEl.textContent = hint.text;
}

// =============================================================================
// _advanceStep -- move to the next hint in the sequence.
//
// Called when advance(state) returns true, or when the user clicks "skip".
// Wraps around after the last step.
// =============================================================================
function _advanceStep() {
  var hints = _helperState.world ? HINTS[_helperState.world] : null;
  if (!hints || hints.length === 0) return;

  _helperState.step = (_helperState.step + 1) % hints.length;
  _updatePanel();
}

// =============================================================================
// onStateUpdate -- called every poll frame by Menu.js when helper mode is on.
//
// Two duties:
//   1. Detect world changes and reset step to 0.
//   2. Check if the current step's advance() condition is met; if so, advance.
//
// @param {Object} state -- window.VP_STATE snapshot from the active world sketch
// =============================================================================
function onStateUpdate(state) {
  if (!state || !state.world) return;

  // --- Derive the hint-world key ---
  // VP_STATE.world is always 'strings' for string.html (both solo and multi).
  // Map solo (stringCount === 1) to the 'string' hint set so the single-string
  // sequence plays; map multi (stringCount >= 2) to 'strings'.
  var hintWorld = state.world;
  if (state.world === 'strings') {
    hintWorld = (state.stringCount === 1) ? 'string' : 'strings';
  }

  // --- World change detection ---
  // Reset to step 0 whenever the hint-world key changes -- this covers both
  // cross-page navigation (e.g. mass -> string) and switching between solo
  // and multi-string scenarios within string.html.
  if (hintWorld !== _helperState.world) {
    _helperState.world = hintWorld;
    _helperState.step  = 0;
    _updatePanel();
    return;  // give one frame before checking advance() on the new world
  }

  // --- Step advance check ---
  // Prevent re-entry: if _advanceLock is set, skip this frame.
  if (_helperState._advanceLock) { _helperState._advanceLock = false; return; }

  var hints = HINTS[hintWorld];
  if (!hints || hints.length === 0) return;

  var step = _helperState.step % hints.length;
  var hint = hints[step];

  // advance() receives the full VP_STATE snapshot; it is allowed to read any field.
  if (hint && hint.advance && hint.advance(state)) {
    _helperState._advanceLock = true;  // skip one frame to let the action settle
    _advanceStep();
  }
}

// =============================================================================
// wireTooltips -- register mouseenter/mouseleave on all interactive menu elements.
//
// Called once from Menu.js _init() after the sidebar and tabs are built.
// Uses event delegation on #vp-tools and #vp-controls so it picks up dynamically
// inserted buttons without needing to re-wire on every vpBuildMenu() call.
// =============================================================================
function wireTooltips() {
  // Delegate from the two stable container elements.
  var containers = [
    document.getElementById('vp-tools'),
    document.getElementById('vp-controls'),
    document.getElementById('vp-tab-bar')
  ];

  for (var ci = 0; ci < containers.length; ci++) {
    var container = containers[ci];
    if (!container) continue;

    container.addEventListener('mouseenter', function(e) {
      if (!_helperState.enabled) return;
      var target = e.target;
      // Walk up to find the nearest element with an ID or data-tab in TOOLTIPS.
      var tip = _findTooltip(target);
      if (tip) _showTooltip(tip, e);
    }, true);   // capture phase so we see the event before the button's own handlers

    container.addEventListener('mouseleave', function(e) {
      _hideTooltip();
    }, true);
  }
}

// =============================================================================
// _findTooltip -- walk up the DOM from target to find tooltip text.
//
// Checks: element ID in TOOLTIPS, then data-tab attribute (for tab buttons).
//
// @param {Element} el -- the event target
// @returns {string|null} -- tooltip text, or null if none found
// =============================================================================
function _findTooltip(el) {
  // Walk up at most 3 levels (button > span > icon, etc.)
  for (var depth = 0; depth < 4 && el && el !== document.body; depth++) {
    if (el.id && TOOLTIPS[el.id]) return TOOLTIPS[el.id];
    // Tab buttons use data-tab attribute mapped to 'tab-<key>' id pattern.
    if (el.dataset && el.dataset.tab && TOOLTIPS['tab-' + el.dataset.tab]) {
      return TOOLTIPS['tab-' + el.dataset.tab];
    }
    el = el.parentElement;
  }
  return null;
}

// =============================================================================
// _showTooltip -- position and display the tooltip near the mouse cursor.
//
// Positions below the element; nudges left if it would overflow the right edge.
//
// @param {string}       text  -- tooltip content
// @param {MouseEvent}   e     -- original mouseenter event
// =============================================================================
function _showTooltip(text, e) {
  if (!_tooltipEl) return;
  _tooltipEl.textContent = text;
  _tooltipEl.style.display = 'block';

  // Position near the hovered element (below it, aligned to its left).
  var rect = e.currentTarget.getBoundingClientRect
    ? e.currentTarget.getBoundingClientRect()
    : { left: e.clientX, bottom: e.clientY };

  // Use the target element for better positioning.
  if (e.target && e.target.getBoundingClientRect) {
    var btnRect = e.target.getBoundingClientRect();
    // Walk up to find the button (not text node children)
    var btn = e.target;
    while (btn && btn.getBoundingClientRect && !btn.id && btn.parentElement) {
      btn = btn.parentElement;
    }
    if (btn && btn.getBoundingClientRect) {
      btnRect = btn.getBoundingClientRect();
    }
    var left = btnRect.left + window.scrollX;
    var top  = btnRect.bottom + window.scrollY + 6;
    _tooltipEl.style.left = left + 'px';
    _tooltipEl.style.top  = top  + 'px';
  } else {
    _tooltipEl.style.left = (e.clientX + window.scrollX) + 'px';
    _tooltipEl.style.top  = (e.clientY + window.scrollY + 20) + 'px';
  }

  // Prevent right-edge overflow: clamp to viewport.
  var tipW = _tooltipEl.offsetWidth;
  var viewW = window.innerWidth;
  var leftPx = parseFloat(_tooltipEl.style.left);
  if (leftPx + tipW > viewW - 10) {
    _tooltipEl.style.left = Math.max(0, viewW - tipW - 10) + 'px';
  }
}

// =============================================================================
// _hideTooltip -- hide the tooltip element.
// =============================================================================
function _hideTooltip() {
  if (_tooltipEl) _tooltipEl.style.display = 'none';
}

// =============================================================================
// wireToggle -- attach click handler to #btn-helper in the nav bar.
//
// Called from Menu.js _init() after Nav.js has rendered the button.
// Routes through _enable()/_disable() so cookie persistence and button sync
// happen regardless of which entry point (nav button vs in-panel button) is used.
// =============================================================================
function wireToggle() {
  var btn = document.getElementById('btn-helper');
  if (!btn) return;

  // Sync button visual state with current enabled flag (set by _buildOverlay init).
  _syncNavBtn(_helperState.enabled);

  btn.addEventListener('click', function() {
    if (_helperState.enabled) {
      _disable();
    } else {
      _enable();
    }
  });
}

// =============================================================================
// Module init: build overlay elements, then apply default-on logic.
//
// Helper mode starts ON unless the user has previously turned it off
// (indicated by the vp_helper_off=1 cookie). This runs synchronously at
// script load time; the DOM (including #canvas-container and #btn-helper
// from Nav.js) is already available because all script tags are at end of body.
// =============================================================================
_buildOverlay();

// Default ON: enable immediately unless the user has opted out (window.name marker set).
if (!_cookieIsOff()) {
  // Set state and class directly (wireToggle has not run yet so there is no
  // nav button listener to update; _syncNavBtn is called later by wireToggle).
  _helperState.enabled = true;
  document.body.classList.add('vp-helper');
}

// =============================================================================
// Public API: window.vpHelper
// =============================================================================
window.vpHelper = {
  // enabled: true when helper mode is active (body.vp-helper class is set).
  get enabled() { return _helperState.enabled; },

  // onStateUpdate(state): called by Menu.js _poll() each frame.
  onStateUpdate: onStateUpdate,

  // wireTooltips(): call once after sidebar/tabs are built.
  wireTooltips: wireTooltips,

  // wireToggle(): call once from Menu.js _init().
  wireToggle: wireToggle
};
