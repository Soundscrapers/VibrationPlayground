/**
 * StringInteractionController.js
 *
 * Responsibility:
 * - Route pointer events for string world to the appropriate tool or action.
 * - Manage audio context startup on the first user gesture.
 * - Expose stub methods so sketch.js can call the same interface it uses
 *   for the MDOF InteractionController without branching everywhere.
 *
 * NOT allowed to:
 * - Draw anything.
 * - Advance time or call step().
 * - Mutate StringDefinition physics parameters (except via toggleBoundary,
 *   which is a well-defined interface operation).
 *
 * -------------------------------------------------------------------
 * Event priority on pointer down:
 *
 *   1. Boundary toggle  -- click within 20px of left or right endpoint
 *                          circle --> flip that end's boundary condition.
 *   2. StrikeTool/Pluck -- click anywhere else on the string body:
 *       - Quick release (< 200ms hold) --> velocity impulse (strike).
 *       - Hold > 200ms then drag       --> triangular displacement (pluck).
 *
 * Future steps will add:
 *   3. HoldTool node    -- tool mode 'hold', click creates fixed node (Step 8)
 * -------------------------------------------------------------------
 */

class StringInteractionController {

  /**
   * constructor
   *
   * @param {Object} opts
   * @param {StringDefinition} opts.stringDef    -- the live string definition object
   * @param {ModalState}       opts.modalState   -- the live modal state object
   * @param {Object|null}      opts.soundObserver -- StringSoundObserver (null until Step 6)
   * @param {Object}           opts.screenGeom   -- { xLeft, xRight, Lx, yCenter, yScale }
   *                                                precomputed pixel geometry from sketch.js
   */
  constructor(opts) {

    // ------------------------------------------------------------------
    // Multi-string vs single-string mode.
    //
    // Multi-string: opts.strings is an array [{def, state, yCenter, ...}].
    //   this.strings and this.sharedGeom are set.
    //   this.stringDef / this.modalState / this.screenGeom are updated
    //   in pointerDown() to target whichever string is closest to the click.
    //
    // Single-string: opts.stringDef and opts.modalState are provided directly.
    //   this.strings and this.sharedGeom are null; behavior is unchanged.
    // ------------------------------------------------------------------
    if (opts.strings) {
      // Multi-string mode: strings[] is the array of string bundles.
      this.strings      = opts.strings;
      this.sharedGeom   = opts.sharedGeom;
      this._multiString = true;
      // _activeStringIdx: index of the string targeted by the current gesture.
      // Initialized to 0; updated by _closestStringIndex() in pointerDown().
      this._activeStringIdx = 0;
      // Initialize live refs to first string so all code paths have valid refs.
      this.stringDef    = opts.strings[0].def;
      this.modalState   = opts.strings[0].state;
      this.screenGeom   = { ...opts.sharedGeom, yCenter: opts.strings[0].yCenter };
      this.soundObserver = null;  // sound added in Step 2
    } else {
      // Single-string mode: unchanged from pre-multi behavior.
      this.strings      = null;
      this.sharedGeom   = null;
      this._multiString = false;
      this._activeStringIdx = 0;
      this.stringDef    = opts.stringDef;
      this.modalState   = opts.modalState;
      this.soundObserver = opts.soundObserver || null;
      this.screenGeom   = opts.screenGeom;
    }

    // Audio context state.
    // Web Audio requires a user gesture before Tone.js can make sound.
    // This flag ensures we only call Tone.start() once.
    this.audioStarted = false;

    // Current tool mode. Only 'pointer' is active in Step 4.
    // Step 8 will add 'hold' for fixed-node creation.
    this.currentTool = 'pointer';

    // StrikeTool: handles click-and-release velocity impulses.
    this.strikeTool = new StrikeTool({
      hammerWidth: 0.05   // 5% of string length -- moderate frequency content
    });

    // ------------------------------------------------------------------
    // Pluck drag state (Step 7).
    //
    // A pluck is a hold-and-drag gesture:
    //   - pointer held > PLUCK_THRESHOLD_MS without releasing --> pluck mode.
    //   - quick release (< threshold)                         --> strike mode.
    //
    // _downTime:    millis() at pointer-down; -1 when no press is active.
    // _downX, _downY: canvas pixel position at pointer-down.
    // _pluckActive: true while in pluck drag (hold threshold crossed).
    // _pluckKsi:    physical x (m) of the pluck grab point, fixed at onset.
    //               The triangular peak is always at this position.
    // ------------------------------------------------------------------
    this._downTime    = -1;
    this._downX       = 0;
    this._downY       = 0;
    this._pluckActive = false;
    this._pluckKsi    = 0;

    // ------------------------------------------------------------------
    // Hold tool / split state (Step 8).
    //
    // _isSplit:   true while a fixed node is active, splitting the string
    //             into two independently vibrating sub-strings.
    // _fixedNode: object holding the split geometry and sub-states:
    //   {
    //     x0:         physical x of the node (m), snapped to nearest grid point
    //     splitIdx:   interior point index of the node in the FULL string grid
    //     leftDef:    StringDefinition for the left sub-string
    //     leftState:  ModalState for the left sub-string
    //     rightDef:   StringDefinition for the right sub-string
    //     rightState: ModalState for the right sub-string
    //   }
    // Only one node is supported in this version. Multiple nodes deferred.
    // ------------------------------------------------------------------
    this._isSplit   = false;
    this._fixedNode = null;

    // ------------------------------------------------------------------
    // Strum crossing detection state.
    //
    // _prevMouseY: canvas y of the pointer in the previous pointerMove() call.
    // null on construction and after each setTool() call (reset to prevent
    // a false crossing on the first frame after switching to strum mode).
    // ------------------------------------------------------------------
    this._prevMouseY = null;

    // ------------------------------------------------------------------
    // Active sub-string refs for pointer interaction while split.
    //
    // When _isSplit and tool = 'pointer', each click lands in either the
    // left or right sub-string. These refs are set in pointerDown to
    // point at whichever sub-string was clicked, then used by pointerMove
    // and pointerUp so strike/pluck write into that sub-string's ModalState.
    //
    // _activeSubState:    ModalState of the clicked sub-string.
    // _activeSubDef:      StringDefinition of the clicked sub-string.
    // _activeSubScreenGeom: adjusted screen geometry for the sub-string
    //   (xLeft/xRight clamped to that half's screen span; Lx updated).
    //   Passed to StrikeTool so ksi maps correctly to the sub-string's
    //   local coordinate (0..L_sub) instead of the full string.
    // ------------------------------------------------------------------
    this._activeSubState     = null;
    this._activeSubDef       = null;
    this._activeSubScreenGeom = null;

    // ------------------------------------------------------------------
    // Endpoint tension-drag state.
    //
    // With pointer tool, pressing on an endpoint (xLeft or xRight) and
    // dragging vertically adjusts the tension of the adjacent string:
    //   - drag up   --> increase tension --> higher pitch
    //   - drag down --> decrease tension --> lower pitch
    //
    // A quick press-release with no significant drag toggles the boundary
    // condition as before (fixed <--> free).
    //
    // Interior nodes (the split node in the middle) are NOT affected --
    // _isNearEndpoint only tests xLeft and xRight, not nodeScreenX.
    //
    // _endpointSide:       'left' | 'right' | null -- which endpoint is pressed
    // _endpointDownY:      canvas y at pointer-down (drag origin)
    // _baseTension:        tension of the adjacent string at pointer-down
    // _endpointDragActive: true once the pointer has moved enough to drag
    // _endpointIsFixed:    true when the pressed endpoint has a fixed BC.
    //                      Tension drag is only permitted for fixed endpoints.
    //                      Free endpoints: click still toggles to fixed, but
    //                      drag is suppressed.
    // ------------------------------------------------------------------
    this._endpointSide       = null;
    this._endpointDownY      = 0;
    this._baseTension        = 0;
    this._endpointDragActive = false;
    this._endpointIsFixed    = false;
  }

  // ------------------------------------------------------------------
  // pointerDown -- handle the start of a pointer gesture.
  //
  // Priority:
  //   1. Endpoint hit --> toggle boundary condition, rebuild modal basis.
  //      _downTime is left at -1 to suppress any pluck/strike on release.
  //   2. String body --> record timing, begin recording a strike.
  //      Gesture type (pluck vs strike) is decided in pointerMove/pointerUp.
  //
  // @param {number} x -- canvas pixel x
  // @param {number} y -- canvas pixel y
  // ------------------------------------------------------------------
  pointerDown(x, y) {

    // Every first gesture unlocks the Web Audio context.
    this.ensureAudioStarted();

    // ------------------------------------------------------------------
    // Multi-string routing: select the string closest to the click y.
    //
    // Updates this.stringDef, this.modalState, and this.screenGeom to
    // point at the clicked string for the duration of this gesture.
    // All subsequent code (boundary toggle, strike, pluck) then operates
    // on whichever string was selected here, using its local yCenter.
    // ------------------------------------------------------------------
    if (this._multiString) {
      this._activeStringIdx = this._closestStringIndex(y);
      const s = this.strings[this._activeStringIdx];
      this.stringDef     = s.def;
      this.modalState    = s.state;
      this.soundObserver = s.sound;  // route triggerStrike to this string's KS voice
      // Build per-string screenGeom: same horizontal span as sharedGeom,
      // but with this string's vertical center substituted in.
      this.screenGeom = {
        xLeft:         this.sharedGeom.xLeft,
        xRight:        this.sharedGeom.xRight,
        Lx:            this.sharedGeom.Lx,
        yCenter:       s.yCenter,
        yScale:        this.sharedGeom.yScale,
        velocityGain:  this.sharedGeom.velocityGain,
        maxYFraction:  this.sharedGeom.maxYFraction   // propagate per-scenario clamp
      };
      // Sync per-string split state into instance vars so all downstream code
      // (_isSplit checks, _splitAtNode, _mergeNodes, sub-string routing in
      // pointerMove/Up) operates on this string's hold state for this gesture.
      this._isSplit   = s.isSplit   || false;
      this._fixedNode = s.fixedNode || null;

      // Y-range guard: only proceed if the click is within the hit band of the
      // nearest string.  hitHalfBand = spacing/2 for multi-string (set in
      // _initMultiStrings), so clicks in the dead zone between two strings
      // (or beyond the outermost strings) are silently ignored.
      const hitBand = this.sharedGeom.hitHalfBand || Infinity;
      if (Math.abs(y - this.screenGeom.yCenter) > hitBand) return;
    }

    // Reset interaction state on every new press.
    this._pluckActive        = false;
    this._pluckKsi           = 0;
    this._endpointSide       = null;
    this._endpointDragActive = false;

    // ------------------------------------------------------------------
    // Hold tool path (Step 8):
    // When tool = 'hold', clicks create or release a fixed node.
    // This entirely replaces the boundary-toggle / strike / pluck path.
    // Return early so neither boundary toggle nor strike fires.
    // ------------------------------------------------------------------
    if (this.currentTool === 'hold') {
      if (this._isSplit) {
        // Click anywhere while split = release node, merge sub-strings back.
        this._mergeNodes();
      } else {
        // Click on string body = create fixed node at the clicked x position.
        // Clamp to [0, L] then snap to the nearest interior grid point.
        const g = this.screenGeom;
        const x0 = Math.max(0, Math.min(
          this.stringDef.L,
          (x - g.xLeft) / g.Lx * this.stringDef.L
        ));
        this._splitAtNode(x0);
      }
      return;   // boundary toggle / strike / pluck must NOT fire in hold mode
    }

    // --- Priority 1: endpoint press (tension drag OR boundary toggle) ---
    //
    // Do NOT toggle immediately. Record the endpoint side and wait:
    //   pointerMove with drag --> tension drag (applied live)
    //   pointerUp with no drag --> boundary toggle (fixed <--> free)
    //
    // _downTime = -1 suppresses the pluck/strike 200ms timer so dragging
    // an endpoint never accidentally starts a pluck on the string body.
    //
    // Endpoint detection is skipped in strum mode. A click near an endpoint
    // while strumming just registers as a string-body press; the strum crossing
    // fires in pointerMove when the mouse sweeps across the strings.
    if (this.currentTool === 'pointer') {
      if (this._isNearEndpoint(x, y, 'left')) {
        const leftDef            = this._getActiveTensionDefForSide('left');
        this._endpointSide       = 'left';
        this._endpointDownY      = y;
        this._baseTension        = leftDef.tension;
        this._endpointDragActive = false;
        // Tension drag is only allowed for fixed BCs.  Free endpoints respond
        // to a single click (toggle to fixed) but not to drag.
        this._endpointIsFixed    = (leftDef.boundaryLeft === 'fixed');
        this._downTime           = -1;
        return;
      }

      if (this._isNearEndpoint(x, y, 'right')) {
        const rightDef           = this._getActiveTensionDefForSide('right');
        this._endpointSide       = 'right';
        this._endpointDownY      = y;
        this._baseTension        = rightDef.tension;
        this._endpointDragActive = false;
        // Tension drag is only allowed for fixed BCs.
        this._endpointIsFixed    = (rightDef.boundaryRight === 'fixed');
        this._downTime           = -1;
        return;
      }
    }

    // --- Priority 2: string body --- record timing for pluck/strike decision.
    // millis() is the p5.js elapsed-time function (milliseconds since sketch start).
    this._downTime = millis();
    this._downX    = x;
    this._downY    = y;

    // When split, determine which sub-string the click falls in and set the
    // active sub refs so pointerMove / pointerUp target the correct ModalState.
    // The split point (node) lies at screen x = xLeft + (x0/L) * Lx.
    if (this._isSplit && this._fixedNode) {
      const g = this.screenGeom;
      const nodeScreenX = g.xLeft + (this._fixedNode.x0 / this.stringDef.L) * g.Lx;

      if (x <= nodeScreenX) {
        // Click is in the left sub-string.
        this._activeSubState = this._fixedNode.leftState;
        this._activeSubDef   = this._fixedNode.leftDef;
        this._activeSubScreenGeom = {
          xLeft:       g.xLeft,
          xRight:      nodeScreenX,
          Lx:          nodeScreenX - g.xLeft,
          yCenter:     g.yCenter,
          yScale:      g.yScale,
          velocityGain: g.velocityGain || 1
        };
      } else {
        // Click is in the right sub-string.
        this._activeSubState = this._fixedNode.rightState;
        this._activeSubDef   = this._fixedNode.rightDef;
        this._activeSubScreenGeom = {
          xLeft:       nodeScreenX,
          xRight:      g.xRight,
          Lx:          g.xRight - nodeScreenX,
          yCenter:     g.yCenter,
          yScale:      g.yScale,
          velocityGain: g.velocityGain || 1
        };
      }
    } else {
      // Whole string: active refs point to the main state.
      this._activeSubState      = null;
      this._activeSubDef        = null;
      this._activeSubScreenGeom = null;
    }

    // Start strike recording using the active def and screen geometry.
    // If pluck mode activates before pointerUp, strikeTool.cancel() is called.
    const activeDef  = this._activeSubDef      || this.stringDef;
    const activeGeom = this._activeSubScreenGeom || this.screenGeom;
    this.strikeTool.pointerDown(x, y, activeDef, activeGeom);
  }

  // ------------------------------------------------------------------
  // pointerUp -- finalize the current gesture.
  //
  // Branch on whether a pluck drag was active or a quick strike occurred.
  //
  // Pluck release:
  //   The triangular displacement is already written to modalState by
  //   pointerMove(). On release we stop writing and let the string ring
  //   freely from the current triangular shape. Sound is triggered with
  //   a velocity estimate proportional to the pluck height.
  //
  // Quick strike:
  //   StrikeTool.pointerUp() injects the velocity impulse and records
  //   the pendingStrike. We forward that to the sound observer.
  //
  // @param {number} x -- canvas pixel x at release
  // @param {number} y -- canvas pixel y at release
  // ------------------------------------------------------------------
  pointerUp(x, y) {

    // ---- Endpoint gesture: tension drag or boundary toggle ----
    // This check is BEFORE the _downTime guard because endpoint presses
    // set _downTime = -1 to suppress pluck/strike.
    if (this._endpointSide !== null) {
      // Use release-vs-press y-distance to decide click vs drag.
      // _endpointDragActive is also checked, but cannot be relied on alone
      // because mouseDragged may be skipped (e.g. when mouse exits canvas bounds
      // or the _isCanvasEvent filter blocks the event).  Comparing positions
      // directly is always reliable regardless of which intermediate events fire.
      //
      // Threshold: 6px.  Smaller = accidental tremor counts as click.
      //            Larger = short intentional drags may accidentally toggle.
      const DRAG_THRESHOLD = 6;   // px
      const dy = Math.abs(y - this._endpointDownY);

      if (!this._endpointIsFixed) {
        // Free endpoint: no tension drag.  Any gesture (click OR drag-ignored)
        // toggles to fixed.  _endpointDragActive is always false for free ends.
        this._toggleBoundaryForSide(this._endpointSide);

      } else if (dy < DRAG_THRESHOLD && !this._endpointDragActive) {
        // Fixed endpoint, no drag detected by either mechanism: single click.
        // Toggle to free.
        this._toggleBoundaryForSide(this._endpointSide);

        // else: fixed endpoint with drag -- tension was applied live in pointerMove.
        // Leave boundary condition unchanged.  No toggle.
      }

      this._endpointSide       = null;
      this._endpointDragActive = false;
      return;
    }

    // Strum mode: pointer down/up do not fire strikes or plucks.
    // Strum impulses are injected in pointerMove() via crossing detection.
    // Reset _downTime so state is clean for the next gesture.
    if (this.currentTool === 'strum') {
      this._downTime = -1;
      return;
    }

    // No active press (hold-tool or boundary toggle consumed the gesture).
    if (this._downTime < 0) return;

    // Resolve which ModalState / StringDefinition / screen geometry to use.
    // When split and an active sub was selected in pointerDown, use it.
    // Otherwise fall back to the whole-string objects.
    const activeState = this._activeSubState      || this.modalState;
    const activeDef   = this._activeSubDef        || this.stringDef;
    const activeGeom  = this._activeSubScreenGeom || this.screenGeom;

    // Fundamental Hz of the active string, for KS pitch matching.
    // omega[0] / (2*pi) gives the physics fundamental; KS plays at this pitch.
    const hz = (activeDef.omega && activeDef.omega.length > 0)
             ? activeDef.omega[0] / (2 * Math.PI)
             : undefined;

    if (this._pluckActive) {
      // ---- Pluck release ----
      // The shape was written each frame into activeState by pointerMove.
      // Stop writing: the string (or sub-string) now rings freely.
      // Apply the same displacement clamp used during the drag.
      // maxYFraction is set per-scenario in stringSharedGeom (larger for single string).
      const maxYOff = (activeGeom.maxYFraction || 0.30) * activeGeom.yCenter;
      const yc   = Math.max(activeGeom.yCenter - maxYOff, Math.min(activeGeom.yCenter + maxYOff, y));
      const h    = (activeGeom.yCenter - yc) / activeGeom.yScale;
      const gain = activeGeom.velocityGain || 1.0;
      const v0   = Math.abs(h) * gain;

      if (this.soundObserver && Math.abs(h) > 1e-4) {
        // Pass hz so the KS voice plays at the correct sub-string pitch.
        this.soundObserver.triggerStrike(this._pluckKsi, v0, hz);
      }

      this._pluckActive = false;

    } else {
      // ---- Quick strike release ----
      this.strikeTool.pointerUp(activeState, activeDef);
      const strike = this.strikeTool.consumeStrikeEvent();
      if (strike && this.soundObserver) {
        this.soundObserver.triggerStrike(strike.ksi, strike.v0, hz);
      }
    }

    // Reset timing -- press is over.
    this._downTime = -1;
  }

  // ------------------------------------------------------------------
  // pointerMove -- handle pointer drag during an active press.
  //
  // If the pointer has been held for > PLUCK_THRESHOLD_MS (200ms) and is
  // on the string body, transition to pluck mode:
  //   1. Cancel the in-progress strike (so pointerUp doesn't fire a click).
  //   2. Lock the pluck position (ksi) at the pointer's current x.
  //   3. Each drag frame: recompute the triangular shape from ksi and
  //      current y-offset (h), write it to modalState via setPhysicalState.
  //
  // If threshold not yet crossed, does nothing (waiting for the hold).
  //
  // @param {number} x -- canvas pixel x
  // @param {number} y -- canvas pixel y
  // ------------------------------------------------------------------
  pointerMove(x, y) {

    // Capture the previous mouse y, then update for the next frame.
    // prevY is used by the strum block below for crossing detection.
    // Done at the very top so all code paths below have the updated value.
    const prevY = this._prevMouseY;
    this._prevMouseY = y;

    // ---- Strum tool: string crossing detection (multi-string only) ----
    //
    // Strum fires on ANY mouse movement, regardless of whether a button is
    // held. For each string, we detect whether the mouse has crossed that
    // string's yCenter since the previous pointerMove() call. A crossing
    // injects a velocity impulse on that string (physics + KS sound).
    //
    // This block runs BEFORE the _downTime guard so strum works without
    // requiring a click. It also runs before the endpoint-drag guard because
    // strum mode blocks endpoint drag in pointerDown().
    //
    // STRUM_COOLDOWN_MS = 100: each string can only trigger once per 100ms
    // to prevent re-fires from mouse jitter near a string's yCenter.
    if (this._multiString && this.currentTool === 'strum' && prevY !== null) {

      // Unlock Web Audio on the first strum gesture (mouse-move counts as
      // a user interaction for AudioContext policy in modern browsers).
      this.ensureAudioStarted();

      const now = millis();
      const g   = this.sharedGeom;
      // Hammer half-width for the strum impulse: same 5% of L as StrikeTool,
      // expressed as a fraction (2.5% per side of the contact zone center).
      const HW_FRAC = 0.025;

      for (let i = 0; i < this.strings.length; i++) {
        const s  = this.strings[i];
        const yc = s.yCenter;

        // X-range guard: only fire if the pointer is within the string's
        // horizontal span (xLeft..xRight).  Strum must not trigger at the
        // outer canvas margins beyond the string endpoints.
        if (x < g.xLeft || x > g.xRight) continue;

        // Crossing detection: the signed distance from yCenter must change sign.
        // prevDiff * currDiff < 0  -->  one is positive, other is negative.
        // Equal zero (mouse resting exactly on the line) is not a crossing.
        const prevDiff = prevY - yc;
        const currDiff = y    - yc;
        if (prevDiff * currDiff >= 0) continue;   // same side or on the line: no crossing

        // Per-string cooldown: suppress re-trigger for 100ms after last strum.
        if (now - s.cooldown < 100) continue;

        // Horizontal strike position along the string (physical meters, 0..L).
        const ksi = Math.max(0, Math.min(
          s.def.L,
          (x - g.xLeft) / g.Lx * s.def.L
        ));

        // Strum velocity: base component + speed-dependent component.
        //
        // STRUM_BASE: minimum impulse injected on any crossing, regardless of
        //   mouse speed. This gives a slow, deliberate strum a full, clear tone
        //   rather than a barely-audible tap.
        //
        // STRUM_GAIN: amplifier on the speed-dependent term. The raw speed
        //   (dy / yScale * velocityGain) is in m/s; STRUM_GAIN scales it so
        //   the velocity rises quickly with faster mouse movement, producing
        //   an expressive dynamic range across strum speeds.
        //
        // A ceiling (30 m/s) prevents an accidental fast jerk from overdriving
        // the modal solver with an extreme impulse.
        const dy         = Math.abs(y - prevY);
        const STRUM_BASE = 5.0;   // m/s: floor impulse for any strum crossing
        const STRUM_GAIN = 4.0;   // amplifies the speed-dependent term
        const speedV = (dy / g.yScale) * g.velocityGain;
        const v0     = Math.min(STRUM_BASE + STRUM_GAIN * speedV, 30.0);

        // Crossing direction determines velocity sign:
        //   prevDiff > 0  -->  mouse was BELOW the string (screen y > yCenter)
        //                      and crossed upward  --> positive velocity (string goes up)
        //   prevDiff < 0  -->  mouse was ABOVE the string (screen y < yCenter)
        //                      and crossed downward --> negative velocity (string goes down)
        // This creates a natural plucking feel: the string moves away from the pick.
        const sign = (prevDiff > 0) ? 1 : -1;

        // Inject velocity impulse into the appropriate ModalState.
        //
        // When the string is split (hold-tool node active), the main state is
        // suppressed in the step loop. We must inject into the sub-state that
        // owns the ksi position; otherwise the impulse is lost.
        //
        // When whole: inject directly into the main state (same as StrikeTool).
        if (s.isSplit && s.fixedNode) {
          const nodeX = s.fixedNode.x0;   // physical x of the split node (m)
          if (ksi <= nodeX) {
            // Left sub-string owns [0, nodeX]. ksi is already in this range.
            const lDef = s.fixedNode.leftDef;
            const lState = s.fixedNode.leftState;
            const lHw = HW_FRAC * lDef.L;
            const lxs = lState.getDisplacements();
            const lvs = lState.getVelocities();
            for (let j = 0; j < lDef.Nx; j++) {
              if (Math.abs(lDef.spatialX[j] - ksi) < lHw) lvs[j] += sign * v0;
            }
            lState.setPhysicalState(lxs, lvs);
          } else {
            // Right sub-string owns (nodeX, L]. Convert ksi to local coords.
            const rDef = s.fixedNode.rightDef;
            const rState = s.fixedNode.rightState;
            const rHw = HW_FRAC * rDef.L;
            const localKsi = ksi - nodeX;   // local x within right sub-string (m)
            const rxs = rState.getDisplacements();
            const rvs = rState.getVelocities();
            for (let j = 0; j < rDef.Nx; j++) {
              if (Math.abs(rDef.spatialX[j] - localKsi) < rHw) rvs[j] += sign * v0;
            }
            rState.setPhysicalState(rxs, rvs);
          }
        } else {
          // Whole string: inject into main state.
          const hw = HW_FRAC * s.def.L;
          const xs = s.state.getDisplacements();
          const vs = s.state.getVelocities();
          for (let j = 0; j < s.def.Nx; j++) {
            if (Math.abs(s.def.spatialX[j] - ksi) < hw) vs[j] += sign * v0;
          }
          s.state.setPhysicalState(xs, vs);
        }

        // Trigger Karplus-Strong sound on this string.
        // For a split string, use the sub-string's own fundamental so the
        // KS pitch matches the shorter vibrating segment, not the full string.
        if (s.sound) {
          let hz;
          if (s.isSplit && s.fixedNode) {
            const activeDef = (ksi <= s.fixedNode.x0)
                            ? s.fixedNode.leftDef : s.fixedNode.rightDef;
            hz = (activeDef.omega && activeDef.omega.length > 0)
               ? activeDef.omega[0] / (2 * Math.PI) : undefined;
          } else {
            hz = (s.def.omega && s.def.omega.length > 0)
               ? s.def.omega[0] / (2 * Math.PI) : undefined;
          }
          s.sound.triggerStrike(ksi, Math.abs(v0), hz);
        }

        // Record cooldown timestamp so this string won't re-trigger for 300ms.
        s.cooldown = now;
      }

      // Strum absorbs all pointer movement -- skip pluck / endpoint drag below.
      return;
    }

    // ---- Endpoint tension drag ----
    // Must be checked BEFORE the _downTime guard because endpoint presses
    // set _downTime = -1. If _endpointSide is set, the pointer is being
    // dragged from an endpoint -- apply tension change live.
    //
    // Tension drag is DISABLED in true multi-string mode (count > 1).
    // All string.html scenarios use the multi-string controller path
    // (this._multiString = true) even for solo (count=1), so we check
    // strings.length instead of _multiString to allow solo tension drag.
    if (this._multiString && this.strings.length > 1) {
      if (this._endpointSide !== null) return;  // absorb endpoint press; toggle fires on pointerUp
    }
    if (this._endpointSide !== null) {
      // Free endpoints do not support tension drag -- just absorb the move.
      // The boundary toggle will fire on pointerUp if there was no drag.
      if (!this._endpointIsFixed) return;

      // yOffset: positive = dragged upward = increase tension.
      // Screen y increases downward, so upward drag gives (downY - currentY) > 0.
      const yOffset = this._endpointDownY - y;

      // Exponential tension scaling: pow(2, yOffset / sensitivity).
      // sensitivity = yCenter * 0.6 means dragging 60% of the half-canvas
      // height doubles or halves the tension (= one octave pitch shift).
      const sensitivityPx = this.screenGeom.yCenter * 0.6;
      const newT = Math.max(1, Math.min(10000,
        this._baseTension * Math.pow(2, yOffset / sensitivityPx)
      ));

      // Apply tension to the adjacent string (respects split state).
      const def   = this._getActiveTensionDefForSide(this._endpointSide);
      const state = this._getActiveTensionStateForSide(this._endpointSide);
      def.setTension(newT);
      // Rebuild modal coordinates into the new eigenbasis immediately.
      state.rebuild(def);

      // Update KS synth pitch to match the new physical fundamental.
      // In multi-string controller mode (all string.html scenarios) soundObserver
      // is null; each string's sound lives on strings[activeIdx].sound instead.
      if (def.omega.length > 0) {
        const hz = def.omega[0] / (2 * Math.PI);
        const snd = this._multiString
          ? (this.strings[this._activeStringIdx] && this.strings[this._activeStringIdx].sound)
          : this.soundObserver;
        if (snd && snd.setFundamental) snd.setFundamental(hz);
      }

      this._endpointDragActive = true;
      return;
    }

    // No active press -- ignore (mouse drifted over canvas without clicking).
    if (this._downTime < 0) return;

    const PLUCK_THRESHOLD_MS = 200;   // hold duration before pluck mode activates

    if (!this._pluckActive) {
      // Check whether the hold threshold has been crossed.
      if (millis() - this._downTime < PLUCK_THRESHOLD_MS) return;

      // Threshold crossed: activate pluck mode.
      // Cancel the in-progress strike so it doesn't fire on pointerUp.
      this.strikeTool.cancel();

      // Lock the pluck x-position at the current pointer location.
      // Use the active sub-string's screen geometry when split so ksi is
      // in the sub-string's local coordinate (0..L_sub), not the full string.
      const ag = this._activeSubScreenGeom || this.screenGeom;
      const ad = this._activeSubDef        || this.stringDef;
      this._pluckKsi = Math.max(0, Math.min(
        ad.L,
        (x - ag.xLeft) / ag.Lx * ad.L
      ));

      this._pluckActive = true;
    }

    // ---- Active pluck drag: write triangular shape each frame ----
    const ag = this._activeSubScreenGeom || this.screenGeom;
    const ad = this._activeSubDef        || this.stringDef;
    const as_ = this._activeSubState     || this.modalState;

    // Clamp displacement to maxYFraction of yCenter pixels from the string centre.
    // maxYFraction is set in stringSharedGeom: 0.30 for multi-string (constrained by
    // string spacing), 0.45 for single string (larger visual swing).
    const maxYOff = (ag.maxYFraction || 0.30) * ag.yCenter;
    const yc = Math.max(ag.yCenter - maxYOff, Math.min(ag.yCenter + maxYOff, y));
    const h = (ag.yCenter - yc) / ag.yScale;   // peak displacement (m), signed (+up)

    this._writePluckShape(this._pluckKsi, h, as_, ad);
  }

  // ------------------------------------------------------------------
  // update -- per-frame update called by sketch.js before step().
  //
  // Three suppression cases:
  //   1. Pluck drag active: shape written by pointerMove() each frame.
  //      Suppress main step so velocities don't fight the prescribed shape.
  //   2. Split active: step the two sub-states independently and suppress
  //      the main modalState.step() so the whole-string integrator does
  //      not overwrite the sub-string motion.
  //   3. Normal: return false, let sketch.js call modalState.step(dt).
  //
  // @param {ModalState} modalState   -- current frame's modal state (same object
  //                                     as this.modalState; passed for API parity
  //                                     with MDOF InteractionController)
  // @param {number}     forcingTime  -- (unused in string world)
  // @param {number}     dt           -- time step (seconds); needed to advance sub-states
  // @returns {boolean}  true if physics step should be suppressed this frame
  // ------------------------------------------------------------------
  update(modalState, forcingTime, dt) {
    // While pluck drag is active, the shape is being written by pointerMove().
    // Suppress the integrator so velocities don't accumulate and fight the shape.
    if (this._pluckActive) return true;

    // While split, advance both sub-strings and suppress the main integrator.
    // Guard: dt must be provided and positive (frozen frame sends dt = 0).
    if (this._isSplit && this._fixedNode && dt !== undefined && dt > 0) {
      // When a pluck drag is active on one sub-string, pointerMove() writes
      // its shape each frame, so skip that sub-string's integrator step to
      // prevent accumulated velocities from fighting the prescribed shape.
      // The other sub-string still evolves freely.
      const pluckingLeft  = this._pluckActive && this._activeSubState === this._fixedNode.leftState;
      const pluckingRight = this._pluckActive && this._activeSubState === this._fixedNode.rightState;
      if (!pluckingLeft)  this._fixedNode.leftState.step(dt);
      if (!pluckingRight) this._fixedNode.rightState.step(dt);
      return true;   // suppress main modalState.step(dt) this frame
    }

    return false;
  }

  // ------------------------------------------------------------------
  // getDrawState -- return a descriptor for the renderer.
  //
  // When split: instructs StringVisualObserver to draw two sub-strings
  //   and a node indicator instead of the whole-string polyline.
  // When whole: renderer falls back to its standard draw path.
  //
  // @returns {Object}
  //   mode: 'split' | 'whole'
  //   (split only) nodeKsi:    physical x of the fixed node (m)
  //   (split only) leftState:  ModalState for the left sub-string
  //   (split only) leftDef:    StringDefinition for the left sub-string
  //   (split only) rightState: ModalState for the right sub-string
  //   (split only) rightDef:   StringDefinition for the right sub-string
  // ------------------------------------------------------------------
  getDrawState() {
    // Collect tension drag info (null when no drag is active).
    const dragInfo = this._getEndpointDragInfo();

    if (this._isSplit && this._fixedNode) {
      return {
        mode:       'split',
        nodeKsi:    this._fixedNode.x0,
        leftState:  this._fixedNode.leftState,
        leftDef:    this._fixedNode.leftDef,
        rightState: this._fixedNode.rightState,
        rightDef:   this._fixedNode.rightDef,
        dragInfo:   dragInfo
      };
    }
    return { mode: 'whole', dragInfo: dragInfo };
  }

  // ------------------------------------------------------------------
  // _getEndpointDragInfo -- build drag info for the visual overlay.
  //
  // Returns null when no tension drag is active.
  // Otherwise returns { side, tension, hz } so the visual observer can
  // draw the tension/frequency readout near the dragged endpoint.
  // ------------------------------------------------------------------
  _getEndpointDragInfo() {
    if (!this._endpointDragActive || this._endpointSide === null) return null;
    const def = this._getActiveTensionDefForSide(this._endpointSide);
    // Physics fundamental in Hz. Multiply by AUDIO_SCALE (100) to get the
    // audible KS pitch -- this is what the user hears, so show that number.
    const physHz = def.omega.length > 0 ? def.omega[0] / (2 * Math.PI) : 0;
    const audioScale = this.soundObserver ? this.soundObserver.AUDIO_SCALE : 100;
    return {
      side:    this._endpointSide,       // 'left' or 'right'
      tension: def.tension,               // current tension (N)
      hz:      physHz * audioScale        // audible KS frequency (Hz)
    };
  }

  // ------------------------------------------------------------------
  // Stub methods for sketch.js API parity with InteractionController.
  //
  // sketch.js reads these from whatever interaction object is active.
  // String world has no holding, forcing, coupling, or add-mass hover,
  // so these all return empty / null / -1.
  // ------------------------------------------------------------------

  // getTool -- returns the current tool name.
  // sketch.js may read this to draw a cursor or show a panel state.
  getTool() { return this.currentTool; }

  // setHammerWidth -- update the hammer contact zone as a fraction of string length.
  // w is clamped to [0.01, 0.50] so the hammer is always at least 1% and at most
  // half the string length.  StrikeTool.pointerUp() reads this.strikeTool.hammerWidth
  // each time a strike fires, so the new value takes effect on the next strike.
  setHammerWidth(w) {
    this.strikeTool.hammerWidth = Math.max(0.01, Math.min(0.50, w));
  }

  // setTool -- change the active tool by name, with toggle semantics.
  // Called by window.vpSetTool() and keyPressed() in sketch.js.
  // If the requested tool is already active, switch back to 'pointer'
  // (so pressing 'h' again deactivates the hold tool).
  //
  // Switching to 'pointer' while split does NOT merge the sub-strings.
  // The user can pluck and play each half independently while in pointer mode.
  // Merging only happens by clicking in 'hold' mode while split.
  setTool(name) {
    if (this.currentTool === name) {
      // Toggle: pressing the same key again reverts to pointer.
      this.currentTool = 'pointer';
    } else {
      this.currentTool = name;
    }
    // Reset strum prev-position on every tool switch so the first pointerMove()
    // after the switch does not detect a false crossing from stale position data.
    this._prevMouseY = null;
  }

  // getHoldState -- MDOF: Map of fixed masses. String world: null.
  getHoldState() { return null; }

  // getForcingState -- MDOF: kinematic tool forcing state. String world: null.
  getForcingState() { return null; }

  // getCouplingHoverPair -- MDOF: { i, j } for hover highlight. String world: null.
  getCouplingHoverPair() { return null; }

  // getAddMassHoverSide -- MDOF: 'left' | 'right' | null. String world: null.
  getAddMassHoverSide() { return null; }

  // getGroundSpringHoverIdx -- MDOF: mass index of hovered ground spring. String: -1.
  getGroundSpringHoverIdx() { return -1; }

  // clearHover -- MDOF: clears all hover indicators. String world: no-op.
  clearHover() {}

  // ------------------------------------------------------------------
  // _closestStringIndex -- find the string whose yCenter is nearest mouseY.
  //
  // Used by pointerDown to route gestures to the correct string in multi-
  // string mode. Iterates all strings and returns the index of the one
  // with the smallest |yCenter - mouseY|.
  //
  // @param {number} mouseY -- canvas y of the pointer (pixels)
  // @returns {number}      -- index into this.strings (0 = lowest / bottom)
  // ------------------------------------------------------------------
  _closestStringIndex(mouseY) {
    let bestIdx  = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.strings.length; i++) {
      const d = Math.abs(this.strings[i].yCenter - mouseY);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
  }

  // ------------------------------------------------------------------
  // updateMulti -- per-frame update for the multi-string world.
  //
  // Called by sketch.js instead of update() when world === 'strings'.
  // Returns the index of the string whose physics step should be suppressed
  // this frame (-1 = step all strings normally).
  //
  // Suppression case: pluck drag active. The triangular shape is written to
  // the active string by pointerMove() each frame; suppressing its step
  // prevents accumulated velocities from fighting the prescribed shape.
  //
  // Note: hold-tool split suppression is added in Step 4.
  //
  // @param {number} forcingTime -- (unused in string world; API parity)
  // @param {number} dt          -- time step (seconds; unused here)
  // @returns {number}           -- index to suppress, or -1 if none
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // updateMulti -- per-frame update for multi-string world.
  //
  // Called by sketch.js each frame. Returns a Set of string indices whose
  // main ModalState.step() should be suppressed this frame.
  //
  // Two suppression cases:
  //   1. Split string: sub-states are stepped here; main state must not
  //      overwrite them. All split strings are handled in a single loop.
  //   2. Pluck drag active: shape is written by pointerMove() each frame;
  //      suppress the active string's integrator.
  //
  // @param {number} forcingTime -- (unused in string world; API parity)
  // @param {number} dt          -- time step (seconds)
  // @returns {Set<number>}      -- indices to suppress in sketch.js step loop
  // ------------------------------------------------------------------
  updateMulti(forcingTime, dt) {
    const suppress = new Set();

    // Step sub-states for every currently-split string and suppress their main state.
    // Guard: dt must be positive (frozen frame sends dt=0).
    if (dt !== undefined && dt > 0) {
      for (let i = 0; i < this.strings.length; i++) {
        const s = this.strings[i];
        if (s.isSplit && s.fixedNode) {
          s.fixedNode.leftState.step(dt);
          s.fixedNode.rightState.step(dt);
          suppress.add(i);
        }
      }
    }

    // If a pluck drag is active on the current string, suppress its main step.
    if (this._pluckActive) {
      suppress.add(this._activeStringIdx);
    }

    return suppress;
  }

  // ------------------------------------------------------------------
  // getMultiDrawStates -- return a per-string array of drawState objects.
  //
  // Called by sketch.js each frame and forwarded to
  // StringVisualObserver.drawMulti() so each string renders in the correct mode.
  //
  // Each element is one of:
  //   { mode: 'whole' }
  //     -- normal unsplit string; existing draw() whole-string path is used.
  //   { mode: 'split', nodeKsi, leftState, leftDef, rightState, rightDef, dragInfo: null }
  //     -- fixed node active; _drawSplitState() draws two sub-string polylines
  //        plus a node indicator dot.
  //
  // @returns {Object[]} length === this.strings.length
  // ------------------------------------------------------------------
  getMultiDrawStates() {
    // dragInfo: non-null only for the active string when an endpoint drag is live.
    // _getEndpointDragInfo() returns null when no drag is active, so all other
    // strings get null automatically.  The readout appears at the correct vertical
    // position because drawMulti() sets this.screenGeom.yCenter per-string before
    // calling draw(), and _drawTensionReadout() reads this.screenGeom.yCenter.
    const activeDragInfo = this._getEndpointDragInfo();

    return this.strings.map((s, i) => {
      // Assign dragInfo only to the active string; null for all others.
      const dragInfo = (i === this._activeStringIdx) ? activeDragInfo : null;

      if (s.isSplit && s.fixedNode) {
        return {
          mode:       'split',
          nodeKsi:    s.fixedNode.x0,
          leftState:  s.fixedNode.leftState,
          leftDef:    s.fixedNode.leftDef,
          rightState: s.fixedNode.rightState,
          rightDef:   s.fixedNode.rightDef,
          dragInfo:   dragInfo
        };
      }
      return { mode: 'whole', dragInfo: dragInfo };
    });
  }

  // ------------------------------------------------------------------
  // _splitAtNode(x0) -- create a fixed node at physical position x0 (m).
  //
  // Steps:
  //   1. Snap x0 to the nearest interior grid point (splitIdx).
  //   2. Compute left and right sub-string lengths and interior-point counts.
  //      The grid spacing h is the same for both sub-strings as the main string,
  //      so modal projections and spatial shapes are consistent.
  //   3. Snapshot the current full-string physical state (displacements, velocities).
  //   4. Build StringDefinition and ModalState objects for each sub-string.
  //   5. Project the relevant slice of the physical state into each sub-state.
  //   6. Store everything in this._fixedNode and set this._isSplit = true.
  //
  // Grid math:
  //   Full string: spatialX[i] = (i+1) * L / (Nx+1) = (i+1) * h
  //   Left sub-string (indices 0..splitIdx-1):
  //     L_L = (splitIdx + 1) * h = position of the node itself
  //     Nx_L = splitIdx interior points
  //     sub spatialX[i] = (i+1) * h  (same spacing, same positions as original)
  //   Right sub-string (indices splitIdx+1..Nx-1), LOCAL coordinates:
  //     L_R = L - L_L
  //     Nx_R = Nx - splitIdx - 1 interior points
  //     sub spatialX[j] = (j+1) * h  (same spacing, zero at the node)
  //
  // @param {number} x0 -- desired node position (m), will be snapped to grid
  // ------------------------------------------------------------------
  _splitAtNode(x0) {
    const def = this.stringDef;
    const L   = def.L;
    const Nx  = def.Nx;
    const N   = def.N;   // number of modes in the full string

    // Grid spacing of the full string's interior points.
    const h = L / (Nx + 1);

    // Snap x0 to the nearest interior grid index.
    // Interior point i sits at (i+1)*h. Solving: i+1 = x0/h, so i = x0/h - 1.
    let splitIdx = Math.round(x0 / h - 1);

    // Clamp: need at least 1 interior point on EACH side so both sub-strings
    // are valid (a sub-string with 0 interior points is degenerate).
    // Left side needs splitIdx >= 1. Right side needs splitIdx <= Nx - 2.
    splitIdx = Math.max(1, Math.min(Nx - 2, splitIdx));

    // Snapshot the current full-string physical state BEFORE rebuilding anything.
    const mainX = this.modalState.getDisplacements();   // length Nx
    const mainV = this.modalState.getVelocities();       // length Nx

    // Exact physical x of the snapped node.
    const nodeX = (splitIdx + 1) * h;   // position of interior point splitIdx (m)

    // Interior point counts for each sub-string.
    const Nx_L = splitIdx;              // points 0..splitIdx-1 (left of node)
    const Nx_R = Nx - splitIdx - 1;    // points splitIdx+1..Nx-1 (right of node)

    // Sub-string lengths (same grid spacing preserved).
    const L_L = nodeX;                 // left: 0 to nodeX
    const L_R = L - nodeX;            // right: nodeX to L

    // Mode count: use same as full string, clamped to available spatial resolution.
    // A sub-string cannot have more modes than interior points (Nx_L or Nx_R).
    const N_L = Math.max(1, Math.min(N, Nx_L));
    const N_R = Math.max(1, Math.min(N, Nx_R));

    // Read damping parameters stored on the main StringDefinition.
    // StringDefinition.setDamping() writes these so sub-strings get same damping.
    const dampBase      = def._dampBase      !== undefined ? def._dampBase      : 0.1;
    const dampFreqScale = def._dampFreqScale !== undefined ? def._dampFreqScale : 0.0;

    // Build left sub-string definition.
    // Boundary: left end inherits the main string's left BC; right end is fixed
    // (the node is a fixed point, displacement = 0 by definition).
    const leftDef = new StringDefinition({
      length:        L_L,
      tension:       def.tension,
      density:       def.density,
      modes:         N_L,
      spatialPoints: Nx_L,
      boundaryLeft:  def.boundaryLeft,
      boundaryRight: 'fixed',
      damping: { base: dampBase, freqScale: dampFreqScale }
    });

    // Build right sub-string definition.
    // Boundary: left end is fixed (the node); right end inherits main string's right BC.
    const rightDef = new StringDefinition({
      length:        L_R,
      tension:       def.tension,
      density:       def.density,
      modes:         N_R,
      spatialPoints: Nx_R,
      boundaryLeft:  'fixed',
      boundaryRight: def.boundaryRight,
      damping: { base: dampBase, freqScale: dampFreqScale }
    });

    // Create modal states for each sub-string (start at rest; state projected below).
    const leftState  = new ModalState(leftDef);
    const rightState = new ModalState(rightDef);

    // Project the physical state slices into each sub-state.
    // Left: original indices 0..Nx_L-1  (Nx_L = splitIdx points).
    // Node point (index splitIdx) has displacement 0 (fixed) -- not included in either.
    // Right: original indices splitIdx+1..Nx-1  (Nx_R points).
    leftState.setPhysicalState(
      mainX.slice(0, Nx_L),
      mainV.slice(0, Nx_L)
    );
    rightState.setPhysicalState(
      mainX.slice(splitIdx + 1),    // starts at splitIdx+1, runs to end
      mainV.slice(splitIdx + 1)
    );

    // Store the split state.
    this._fixedNode = {
      x0:         nodeX,     // snapped physical position of the node (m)
      splitIdx:   splitIdx,  // interior point index of the node in the full grid
      leftDef:    leftDef,
      leftState:  leftState,
      rightDef:   rightDef,
      rightState: rightState
    };
    this._isSplit = true;

    // In multi-string mode, persist split state into the string bundle so
    // updateMulti() and getMultiDrawStates() can find all split strings,
    // not just the one currently routed to this.stringDef / this.modalState.
    if (this._multiString) {
      const s = this.strings[this._activeStringIdx];
      s.isSplit   = true;
      s.fixedNode = this._fixedNode;
    }
  }

  // ------------------------------------------------------------------
  // _mergeNodes() -- release the fixed node and reconstruct full-string state.
  //
  // Reads displacements and velocities from both sub-states, stitches them
  // back into a full-length Nx array with a zero at the node index, and
  // projects the result into the main ModalState via setPhysicalState().
  //
  // After merge, the string resumes normal (unsplit) time evolution.
  // ------------------------------------------------------------------
  _mergeNodes() {
    if (!this._fixedNode) return;

    const node = this._fixedNode;
    const Nx   = this.stringDef.Nx;

    // Read current state from both sub-strings.
    const leftX  = node.leftState.getDisplacements();   // length Nx_L
    const leftV  = node.leftState.getVelocities();
    const rightX = node.rightState.getDisplacements();  // length Nx_R
    const rightV = node.rightState.getVelocities();

    // Reconstruct full-length arrays.
    // Indices 0..Nx_L-1: from left sub-string.
    // Index   Nx_L      : the node itself, displacement = 0 (was a fixed BC).
    // Indices Nx_L+1..Nx-1: from right sub-string.
    const x = new Array(Nx).fill(0);
    const v = new Array(Nx).fill(0);

    const Nx_L = node.splitIdx;   // number of left interior points

    for (let i = 0; i < Nx_L; i++) {
      x[i] = leftX[i];
      v[i] = leftV[i];
    }
    // x[Nx_L] stays 0 (the fixed node had zero displacement throughout).
    for (let i = 0; i < rightX.length; i++) {
      x[Nx_L + 1 + i] = rightX[i];
      v[Nx_L + 1 + i] = rightV[i];
    }

    // Project the reconstructed state into the main modal basis.
    // setPhysicalState does a Phi^T projection to recover modal coordinates.
    this.modalState.setPhysicalState(x, v);

    // Clear the split state.
    this._fixedNode = null;
    this._isSplit   = false;

    // In multi-string mode, clear the string bundle so updateMulti() and
    // getMultiDrawStates() no longer treat this string as split.
    if (this._multiString) {
      const s = this.strings[this._activeStringIdx];
      s.isSplit   = false;
      s.fixedNode = null;
    }
  }

  // ------------------------------------------------------------------
  // _writePluckShape -- write a triangular displacement profile to ModalState.
  //
  // The triangular shape peaks at ksi with height h:
  //   u(xi) = h * xi / ksi           for xi in [0, ksi]
  //   u(xi) = h * (L - xi) / (L - ksi)  for xi in (ksi, L]
  //
  // This satisfies the fixed-fixed boundary conditions (u=0 at both ends)
  // and is the classical initial condition for a plucked string.
  //
  // setPhysicalState(x, v) converts the physical displacement array into
  // modal coordinates via the Phi^T projection and sets qdot from v.
  // Passing v=0 everywhere freezes the string in this shape (zero velocity),
  // so it rings symmetrically outward from the release point.
  //
  // Guard: if ksi is too close to 0 or L (less than 1% of L), clamp it to
  // avoid division by zero in the slope calculation.
  //
  // @param {number}      ksi   -- physical x-position of the peak (m),
  //                              in the target def's local coordinate (0..def.L)
  // @param {number}      h     -- peak displacement (m), positive = up
  // @param {ModalState}  state -- target state (default: this.modalState)
  // @param {StringDefinition} def -- target definition (default: this.stringDef)
  // ------------------------------------------------------------------
  _writePluckShape(ksi, h, state, def) {
    def   = def   || this.stringDef;
    state = state || this.modalState;
    const L    = def.L;
    const Nx   = def.Nx;

    // Clamp ksi away from endpoints to prevent divide-by-zero.
    const ksic = Math.max(0.01 * L, Math.min(0.99 * L, ksi));

    const x = new Array(Nx).fill(0);   // physical displacements (m)
    const v = new Array(Nx).fill(0);   // velocities = 0 (shape held in place)

    for (let i = 0; i < Nx; i++) {
      const xi = def.spatialX[i];   // physical x of interior point i (m)
      if (xi <= ksic) {
        x[i] = h * xi / ksic;                      // rising slope to peak
      } else {
        x[i] = h * (L - xi) / (L - ksic);          // falling slope from peak
      }
    }

    // Write into modal coordinates. ModalState.setPhysicalState projects
    // the displacement array through Phi^T to get q, and sets qdot from v.
    state.setPhysicalState(x, v);
  }

  // ------------------------------------------------------------------
  // _getActiveTensionDefForSide -- return the StringDefinition whose tension
  // should be adjusted when the given endpoint is dragged.
  //
  // When the string is split:
  //   'left' --> leftDef  (left sub-string is adjacent to xLeft)
  //   'right' --> rightDef (right sub-string is adjacent to xRight)
  // When whole: both sides use the main stringDef.
  //
  // Interior nodes are not reachable via this path because _isNearEndpoint
  // only tests xLeft and xRight, not the split-node screen position.
  // ------------------------------------------------------------------
  _getActiveTensionDefForSide(side) {
    if (this._isSplit && this._fixedNode) {
      return (side === 'left') ? this._fixedNode.leftDef : this._fixedNode.rightDef;
    }
    return this.stringDef;
  }

  // ------------------------------------------------------------------
  // _getActiveTensionStateForSide -- return the ModalState paired with
  // the adjacent StringDefinition for the given endpoint side.
  // ------------------------------------------------------------------
  _getActiveTensionStateForSide(side) {
    if (this._isSplit && this._fixedNode) {
      return (side === 'left') ? this._fixedNode.leftState : this._fixedNode.rightState;
    }
    return this.modalState;
  }

  // ------------------------------------------------------------------
  // _toggleBoundaryForSide -- toggle the boundary condition on one end.
  //
  // Multi-string: toggles ALL strings' BC on the given side so they stay
  //   in sync. The main def is always updated (visual indicator + future
  //   merge correctness). For split strings the outer sub-string endpoint
  //   is also toggled so the vibrating half responds immediately. KS pitch
  //   is updated for non-split strings (split strings use sub-string pitch).
  //
  // Single-string, whole: toggles stringDef and rebuilds modalState.
  // Single-string, split: toggles only the OUTER endpoint of the adjacent
  //   sub-string. Interior node endpoints are always fixed, not toggled.
  // ------------------------------------------------------------------
  _toggleBoundaryForSide(side) {
    if (this._multiString) {
      for (const s of this.strings) {
        // Always toggle the main def and rebuild its modal basis.
        // Keeps the endpoint visual indicator correct and ensures merging a
        // split string later restores the right BC on the full string.
        s.def.toggleBoundary(side);
        s.state.rebuild(s.def);

        // For split strings, also toggle the outer sub-string endpoint so
        // the actively-vibrating half gets the new BC immediately.
        if (s.isSplit && s.fixedNode) {
          if (side === 'left') {
            s.fixedNode.leftDef.toggleBoundary('left');
            s.fixedNode.leftState.rebuild(s.fixedNode.leftDef);
          } else {
            s.fixedNode.rightDef.toggleBoundary('right');
            s.fixedNode.rightState.rebuild(s.fixedNode.rightDef);
          }
        }

        // Update KS synth pitch for non-split strings.
        // BC change alters omega[0]: fixed-fixed -> fixed-free drops the
        // fundamental by half (quarter-wave instead of half-wave mode shape).
        // Split strings use sub-string pitch (set at split time); skip update.
        if (!s.isSplit && s.sound && s.def.omega.length > 0) {
          const hz = s.def.omega[0] / (2 * Math.PI);
          s.sound.setFundamental(hz);
        }
      }
      return;
    }

    // Single-string path (unchanged):
    if (this._isSplit && this._fixedNode) {
      if (side === 'left') {
        this._fixedNode.leftDef.toggleBoundary('left');
        this._fixedNode.leftState.rebuild(this._fixedNode.leftDef);
      } else {
        this._fixedNode.rightDef.toggleBoundary('right');
        this._fixedNode.rightState.rebuild(this._fixedNode.rightDef);
      }
    } else {
      this.stringDef.toggleBoundary(side);
      this.modalState.rebuild(this.stringDef);
    }
  }

  // ------------------------------------------------------------------
  // _isNearEndpoint -- test whether (x, y) is within hit radius of an endpoint.
  //
  // Both endpoint circles are centered at yCenter (the string rest position).
  // Left endpoint is at xLeft; right endpoint is at xRight.
  // Hit radius is 20px -- generous relative to the 6*s rendered circle.
  //
  // @param {number} x    -- canvas pixel x
  // @param {number} y    -- canvas pixel y
  // @param {string} side -- 'left' or 'right'
  // @returns {boolean}
  // ------------------------------------------------------------------
  _isNearEndpoint(x, y, side) {
    const g   = this.screenGeom;
    const epX = (side === 'left') ? g.xLeft : g.xRight;
    const epY = g.yCenter;   // endpoints are always drawn at the rest position

    // Euclidean distance from (x,y) to the endpoint circle center.
    const dist = Math.sqrt((x - epX) * (x - epX) + (y - epY) * (y - epY));
    return dist < 20;   // 20px hit radius
  }

  // ------------------------------------------------------------------
  // ensureAudioStarted -- unlock the Web Audio context on first gesture.
  //
  // Browsers require a user gesture before AudioContext can produce sound.
  // Tone.start() returns a Promise that resolves once the context is running.
  //
  // isMuted is a global boolean managed by sketch.js / the mute button.
  // soundObserver.ensureAudioGraph() builds the Tone.js signal chain the
  // first time audio is available (deferred so nodes aren't created before
  // the context is running).
  // ------------------------------------------------------------------
  ensureAudioStarted() {
    if (this.audioStarted) return;

    if (window.Tone) {
      Tone.start().then(() => {
        // Apply the current mute state (set before audio was running).
        // isMuted is a global from sketch.js.
        if (typeof isMuted !== 'undefined') {
          Tone.Destination.mute = isMuted;
        }
        this.audioStarted = true;
        // Build the audio signal graph now that the context is running.
        // Multi-string: build all strings' graphs simultaneously so every voice
        // is ready before the first strike fires on any string.
        if (this._multiString) {
          for (const s of this.strings) {
            if (s.sound) s.sound.ensureAudioGraph();
          }
        } else if (this.soundObserver) {
          this.soundObserver.ensureAudioGraph();
        }
      });
    } else {
      // Tone.js not loaded (e.g. testing without audio). Mark as started
      // so we don't retry on every gesture.
      this.audioStarted = true;
    }
  }
}
