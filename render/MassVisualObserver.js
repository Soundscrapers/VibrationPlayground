// getModeColor(n, N)
// Returns [r, g, b] for mode index n (0-based) out of N total modes.
//
// Mode 1 (n=0) is always [255, 245, 100] -- warm yellow.
// Highest mode (n=N-1) is always [255, 100, 100] -- red.
// All intermediate modes lerp linearly between those two endpoints.
//
// Unlike the mass color scheme (which distributes across a fixed palette
// regardless of how many masses exist), mode colors always span the full
// yellow-to-red range no matter how many modes there are.
// Single-mode system (N=1): returns the yellow endpoint.
function getModeColor(n, N) {
  const colorA = [255, 245, 100];   // mode 1: yellow
  const colorB = [255, 100, 100];   // highest mode: red
  const t = N > 1 ? n / (N - 1) : 0;
  return [
    Math.round(colorA[0] + t * (colorB[0] - colorA[0])),
    Math.round(colorA[1] + t * (colorB[1] - colorA[1])),
    Math.round(colorA[2] + t * (colorB[2] - colorA[2]))
  ];
}

/**
 * MassVisualObserver
 * ----------------
 * Responsibility:
 * - Render the current physical state visually.
 * - Own visual coordinate conventions.
 *
 * NOT allowed to:
 * - Mutate physics or modal state.
 * - Advance time.
 * - Invent geometry independently of massLayout.
 *
 * v0.15 changes -- dual-center, all-arc geometry:
 *
 * All masses are arcs. No special center-mass vertical line.
 * All mass positions come from window.massLayout (MassLayout.js).
 *
 * Right arc equilibrium: theta = pi (pointing left from rightCenter).
 * Left arc equilibrium:  same angle parameterization, but x is mirrored:
 *   right: x =  layout.centerX + r * cos(theta)
 *   left:  x =  layout.centerX - r * cos(theta)
 * By symmetry, getVisibleArcBounds(r) returns the same result for both sides.
 *
 * Coordinate system (p5.js):
 *   theta = 0     --> right  (toward arc center, off-screen)
 *   theta = pi/2  --> down   (bottom of screen)
 *   theta = pi    --> left   (equilibrium, into canvas)
 *   theta = 3pi/2 --> up     (top of screen)
 *
 *   "top hemisphere":    arcTop  < theta < pi  (arc passes through canvas bottom)
 *   "bottom hemisphere": pi < theta < arcBottom (arc passes through canvas top)
 *
 * Dark mode: background 30, white arc strokes, bright mass colors,
 *   light-gray coupling stitching.
 *
 * clipBuffer = 0: arcs stop exactly at canvas edge.
 *
 * kGround = 0: arc body is not drawn (mass is free-floating, no equilibrium
 *   to sweep around). End circles and coupling stitching draw normally.
 *
 * Garbled UTF-8 comment cleanup applied (per CLAUDE.md):
 *   theta, pi, Phi, omega, zeta, -->, -- (no Unicode Greek letters).
 */

class MassVisualObserver {
  constructor(opts) {
    this.s                  = opts.s;
    this.radiusGap          = opts.radiusGap;
    this.arcSteps           = opts.arcSteps ?? 32;
    this.endCircleRadius    = opts.endCircleRadius;
    this.arcStrokeWeight    = opts.arcStrokeWeight;
    this.couplingStrokeWeight = opts.couplingStrokeWeight;
    this.canvasWidth        = opts.canvasWidth;
    this.canvasHeight       = opts.canvasHeight;

    // Negative clipBuffer pulls arcs in from the canvas edges.
    // 0 = exact edge; -50*s = stop 50 reference-pixels before each edge.
    this.clipBuffer = -50 * this.s;

    // Background gray value -- read from dims so sketch.js owns the single source of truth.
    // Used as the "outer" color in the arc gradient (arcs fade into the background).
    this.bgColor = dims.bgColor;

    this.showForcingDiagnostics = true;

    // Color anchors for visual-position-based interpolation.
    // Innermost pair on both sides = centerColor (blue).
    // Outward on the right --> rightColor (purple).
    // Outward on the left  --> leftColor  (green).
    this.centerColor = [100, 140, 255];   // blue
    this.rightColor  = [200,  80, 255];   // purple
    this.leftColor   = [ 80, 220, 160];   // green
  }

  // ------------------------------------------------------------
  // getMassColor(physicsIndex)
  //
  // Returns [r, g, b] based on visual position, not physics index.
  //
  //   Innermost of either side --> centerColor (blue)
  //   Outward on right side    --> rightColor  (purple), t = k / (nRight-1)
  //   Outward on left side     --> leftColor   (green),  t = k / (nLeft-1)
  //
  // k = steps from innermost: 0 = innermost, max = outermost.
  // Falls back to centerColor if massLayout is not ready.
  // ------------------------------------------------------------
  getMassColor(physicsIndex) {
    const ml = window.massLayout;
    if (!ml) return this.centerColor;

    const layout = ml.get(physicsIndex);
    if (!layout) return this.centerColor;

    const nLeft  = ml._nLeft;
    // cap = max masses per side: color is fixed by slot in the full array,
    // not rescaled to current N. Matches the radius schedule denominator.
    const cap    = ml.dims.maxPerSide;

    let t, colorA, colorB;

    if (layout.side === 'right') {
      // k = 0 at innermost right (visualIndex = nLeft), increases outward
      const k = layout.visualIndex - nLeft;
      t      = k / Math.max(cap - 1, 1);
      colorA = this.centerColor;
      colorB = this.rightColor;
    } else {
      // k = 0 at innermost left (visualIndex = nLeft-1), increases outward
      const k = nLeft - 1 - layout.visualIndex;
      t      = k / Math.max(cap - 1, 1);
      colorA = this.centerColor;
      colorB = this.leftColor;
    }

    return [
      Math.round(colorA[0] + t * (colorB[0] - colorA[0])),
      Math.round(colorA[1] + t * (colorB[1] - colorA[1])),
      Math.round(colorA[2] + t * (colorB[2] - colorA[2]))
    ];
  }

  // ------------------------------------------------------------
  // getVisibleArcBounds(r)
  //
  // Computes the visible angular range for an arc of radius r,
  // using rightCenter as the reference center. By the left-right
  // symmetry of MassLayout, this result is identical for left arcs
  // of the same radius -- so one function serves both sides.
  //
  // Returns { arcTop, arcBottom }:
  //   arcTop    -- outermost visible angle in the top hemisphere (< pi)
  //   arcBottom -- outermost visible angle in the bottom hemisphere (> pi)
  //
  // clipBuffer = 0: clips exactly at canvas boundary.
  // ------------------------------------------------------------
  getVisibleArcBounds(cx, cy, r) {
    const buf = this.clipBuffer;
    const cw  = this.canvasWidth;
    const ch  = this.canvasHeight;

    let arcTop    = 0.05 * Math.PI;
    let arcBottom = 1.95 * Math.PI;

    // Right edge: x = cw + buf
    const cosRight = (cw + buf - cx) / r;
    if (cosRight > -1 && cosRight < 1) {
      const thetaR = Math.acos(cosRight);
      arcTop    = Math.max(arcTop,    thetaR);
      arcBottom = Math.min(arcBottom, 2 * Math.PI - thetaR);
    }

    // Left edge: x = -buf (only reached by very large arcs)
    const cosLeft = (-buf - cx) / r;
    if (cosLeft >= -1 && cosLeft <= 1) {
      const thetaL = Math.acos(cosLeft);
      arcTop    = Math.max(arcTop,    thetaL);
      arcBottom = Math.min(arcBottom, 2 * Math.PI - thetaL);
    }

    // Bottom of canvas: y = ch + buf
    const sinBot = (ch + buf - cy) / r;
    if (sinBot > 0 && sinBot < 1) {
      const thetaB = Math.PI - Math.asin(sinBot);
      arcTop = Math.max(arcTop, thetaB);
    }

    // Top of canvas: y = -buf
    const sinTopEdge = (-buf - cy) / r;
    if (sinTopEdge > -1 && sinTopEdge < 0) {
      const thetaT = Math.PI - Math.asin(sinTopEdge);
      arcBottom = Math.min(arcBottom, thetaT);
    }

    // Safety: ensure arcTop < pi < arcBottom
    arcTop    = Math.min(arcTop,    Math.PI - 0.01);
    arcBottom = Math.max(arcBottom, Math.PI + 0.01);

    return { arcTop, arcBottom };
  }

  // ------------------------------------------------------------
  // mapDisplacementToAngle(x, arcBounds)
  //
  //   x = 0  --> theta = pi  (equilibrium)
  //   x > 0  --> theta < pi  (top hemisphere, toward arcTop)
  //   x < 0  --> theta > pi  (bottom hemisphere, toward arcBottom)
  //
  // Scale = min visible half-span so +-1 fits within visible arc.
  // Clamped to [arcTop, arcBottom].
  // ------------------------------------------------------------
  mapDisplacementToAngle(x, arcBounds) {
    const scale = Math.min(
      Math.PI - arcBounds.arcTop,
      arcBounds.arcBottom - Math.PI
    );
    return constrain(
      Math.PI - scale * x,
      arcBounds.arcTop,
      arcBounds.arcBottom
    );
  }

  // ------------------------------------------------------------
  // angleToDisplacement(angle, arcBounds)  [static utility]
  // Inverse mapping used by HoldTool and KinematicTool.
  // ------------------------------------------------------------
  static angleToDisplacement(angle, arcBounds) {
    const scale = Math.min(
      Math.PI - arcBounds.arcTop,
      arcBounds.arcBottom - Math.PI
    );
    if (scale <= 0) return 0;
    return (Math.PI - angle) / scale;
  }

  // ------------------------------------------------------------
  // getArcPoint(side, cx, cy, r, theta)
  //
  // Returns {x, y} for an arc mass at angle theta.
  //   Right: x =  cx + r * cos(theta)   (standard polar)
  //   Left:  x =  cx - r * cos(theta)   (mirrored in x)
  //
  // At theta = pi (equilibrium):
  //   Right: x = cx - r = canvasMidX + radiusGap/2 + k*decrement  (correct)
  //   Left:  x = cx + r = canvasMidX - radiusGap/2 - k*decrement  (correct mirror)
  // ------------------------------------------------------------
  getArcPoint(side, cx, cy, r, theta) {
    const y = cy + r * Math.sin(theta);
    return side === 'right'
      ? { x: cx + r * Math.cos(theta), y }
      : { x: cx - r * Math.cos(theta), y };
  }

  // ------------------------------------------------------------
  // sampleArc(layout, physAngle, circleRadius, arcBounds)
  //
  // Samples the visible arc into two vertex arrays.
  // Returns { top: [{x,y,ang},...], bottom: [{x,y,ang},...] }.
  //
  // Called only for masses with kGround > 0. Callers skip this for
  // zero-kGround masses and omit the arc body draw entirely.
  // ------------------------------------------------------------
  sampleArc(layout, physAngle, circleRadius, arcBounds) {
    const { side, centerX: cx, centerY: cy, radius: r } = layout;
    const eq     = Math.PI;
    const offset = circleRadius / r;

    // Top hemisphere: arcTop (outer) --> physAngle (end-circle position)
    const topEnd = Math.min(physAngle - offset, eq + offset);
    const top    = [];
    if (topEnd > arcBounds.arcTop) {
      for (let i = 0; i <= this.arcSteps; i++) {
        const ang = lerp(arcBounds.arcTop, topEnd, i / this.arcSteps);
        const pt  = this.getArcPoint(side, cx, cy, r, ang);
        top.push({ x: pt.x, y: pt.y, ang });
      }
    }

    // Bottom hemisphere: arcBottom (outer) --> physAngle
    const bottomStart = Math.max(physAngle + offset, eq - offset);
    const bottom      = [];
    if (bottomStart < arcBounds.arcBottom) {
      for (let i = 0; i <= this.arcSteps; i++) {
        const ang = lerp(arcBounds.arcBottom, bottomStart, i / this.arcSteps);
        const pt  = this.getArcPoint(side, cx, cy, r, ang);
        bottom.push({ x: pt.x, y: pt.y, ang });
      }
    }

    return { top, bottom };
  }

  // ------------------------------------------------------------
  // draw(modalState, mdof, holdState, forcingState, modalForcingIdx)
  //
  // holdState: Map<globalIndex, {displacement}> or null.
  //            A mass is fixed when its index is a key in this Map.
  //
  // Main render entry point. Called every frame by sketch.js.
  // All geometry comes from window.massLayout.
  //
  // modalForcingIdx: physics index of the mass under prescribed-displacement
  //   forcing ('f' key), or -1 if forcing is off. When >= 0, a thick white
  //   outline ring is drawn BEFORE coupling stitching so it appears behind
  //   the arc bodies and coupling lines.
  // ------------------------------------------------------------
  // groundHoverIdx: physics index of the arc whose base is hovered for
  //   ground-spring toggle, or -1.  That arc is drawn in solid 50% gray
  //   instead of its normal color.
  draw(modalState, mdof, holdState, forcingState, modalForcingIdx = -1, groundHoverIdx = -1) {
    const ml            = window.massLayout;
    const displacements = modalState.getDisplacements();
    const velocities    = modalState.getVelocities();
    const N             = displacements.length;

    // Background is now cleared by sketch.js before draw() is called.

    // ---- Precompute per-mass geometry ----
    const layouts      = {};
    const arcBoundsArr = {};
    const physAngles   = {};
    const arcSamples   = {};
    const circleRadii  = {};
    const kGndZero     = {};   // true when kGround[i] === 0; arc body skipped

    for (let i = 0; i < N; i++) {
      const layout = ml.get(i);
      if (!layout) continue;
      layouts[i] = layout;

      // Constant end-circle size (no mass-dependent scaling in v0.15)
      circleRadii[i] = this.endCircleRadius;

      const bounds   = this.getVisibleArcBounds(layout.centerX, layout.centerY, layout.radius);
      arcBoundsArr[i] = bounds;
      kGndZero[i]     = mdof ? (mdof.kGround[i] === 0) : false;

      // Physical displacement --> arc angle (same formula for all masses).
      // x = 0 --> theta = pi (equilibrium); x > 0 --> theta < pi (top hemi).
      physAngles[i] = this.mapDisplacementToAngle(displacements[i], bounds);

      // Only sample arc vertices for masses that have a ground spring.
      // Zero-kGround masses have no equilibrium arc to sweep; their arc body
      // is omitted entirely. End circles and coupling stitching still draw.
      if (!kGndZero[i]) {
        arcSamples[i] = this.sampleArc(layout, physAngles[i], circleRadii[i], bounds);
      }
    }

    // ---- Modal forcing ring (behind everything) ----
    // Drawn first so coupling, arc bodies, and end circles all appear on top.
    if (modalForcingIdx >= 0 && layouts[modalForcingIdx]) {
      this._drawModalForcingRingBehind(layouts[modalForcingIdx], arcBoundsArr[modalForcingIdx]);
    }

    // ---- Coupling stitching (background layer) ----
    strokeWeight(this.couplingStrokeWeight);
    noFill();
    stroke(160, 160, 160, 120);

    const vo = ml.visualOrder;
    for (let vi = 0; vi < vo.length - 1; vi++) {
      const iA = vo[vi];
      const iB = vo[vi + 1];
      if (!layouts[iA] || !layouts[iB]) continue;
      const hasCoupling = (mdof === null) || mdof.hasCoupling(iA, iB);
      if (!hasCoupling) continue;

      this._drawArcArcCoupling(
        layouts[iA],      arcBoundsArr[iA], physAngles[iA], circleRadii[iA],
        layouts[iB],      arcBoundsArr[iB], physAngles[iB], circleRadii[iB]
      );
    }

    // ---- Arc bodies (foreground layer) ----
    // Thick rounded stroke: end circles blend into stroke caps.
    const smallMargin = 2 * this.s;
    const thickWeight = this.endCircleRadius * 2 + smallMargin;
    strokeCap(ROUND);
    strokeWeight(thickWeight);
    noFill();

    for (let vi = 0; vi < vo.length; vi++) {
      const i = vo[vi];
      if (!layouts[i]) continue;

      // Ground spring hover: draw this arc in solid 50% gray to indicate
      // that clicking here will toggle the ground spring on/off.
      // Works for both grounded arcs (kGndZero false) and free-floating arcs
      // (kGndZero true) -- for free masses we compute samples on demand.
      if (i === groundHoverIdx) {
        const samples = arcSamples[i] ||
          this.sampleArc(layouts[i], physAngles[i], circleRadii[i], arcBoundsArr[i]);
        this._drawArcBodyGray(samples);
        continue;
      }

      // Kinematically forced: same velocity gradient as normal but white is the
      // lerp target instead of mass color.  Compute samples on demand in case
      // the mass has kGround=0 (no pre-computed arc from the main sample pass).
      if (forcingState && forcingState.has(i)) {
        const samples = arcSamples[i] ||
          this.sampleArc(layouts[i], physAngles[i], circleRadii[i], arcBoundsArr[i]);
        this._drawArcBody(samples, [255, 255, 255], Math.abs(velocities[i]));
        continue;
      }

      if (kGndZero[i]) continue;   // no arc body for free-floating masses
      this._drawArcBody(arcSamples[i], this.getMassColor(i), Math.abs(velocities[i]));
    }

    // Reset cap and weight before drawing circles
    strokeCap(SQUARE);
    strokeWeight(1);

    // ---- End circles ----
    noStroke();
    for (let vi = 0; vi < vo.length; vi++) {
      const i      = vo[vi];
      if (!layouts[i]) continue;
      // holdState is now a Map (global index --> {displacement}) or null.
      // A mass is "fixed" when its index appears as a key in that Map.
      const isFixed = holdState && holdState.has(i);
      this._drawArcEndCircles(
        layouts[i], arcBoundsArr[i], physAngles[i], circleRadii[i],
        this.getMassColor(i), isFixed
      );
    }

    // ---- Ground spring X indicators ----
    // For every grounded mass (kGround > 0), draw a small X at both
    // arc/buffer intersection points (arcTop and arcBottom endpoints).
    // This marks where the user can click to toggle the ground spring off.
    //
    // Color:
    //   - normal (not hovered): dim gray (80, 80, 80) -- present but subtle
    //   - hovered (groundHoverIdx === i): bright gray (200, 200, 200)
    //
    // armLen = 7 reference pixels, scaled by s for display resolution.
    // strokeWeight(1.5) keeps the X thin but readable at small sizes.
    const armLen = 7 * this.s;
    strokeCap(ROUND);
    strokeWeight(1.5 * this.s);
    noFill();

    for (let vi = 0; vi < vo.length; vi++) {
      const i = vo[vi];
      if (!layouts[i]) continue;
      // X only for masses that currently have a ground spring AND are hovered.
      if (!mdof || mdof.kGround[i] === 0) continue;
      if (i !== groundHoverIdx) continue;

      stroke(200, 200, 200);

      // Top endpoint -- where arc meets the bottom canvas clip boundary.
      // arcBoundsArr[i].arcTop is that outermost angle; getArcPoint converts
      // it to canvas coordinates using the same left/right mirroring formula.
      if (arcSamples[i] && arcSamples[i].top.length > 0) {
        const pt = arcSamples[i].top[0];   // index 0 = outermost (arcTop)
        this._drawX(pt.x, pt.y, armLen);
      }

      // Bottom endpoint -- where arc meets the top canvas clip boundary.
      if (arcSamples[i] && arcSamples[i].bottom.length > 0) {
        const pt = arcSamples[i].bottom[0]; // index 0 = outermost (arcBottom)
        this._drawX(pt.x, pt.y, armLen);
      }
    }

    // Reset stroke state before overlays
    strokeCap(SQUARE);
    strokeWeight(1);

    // ---- Overlay placeholders ----
    if (window.VP_OVERLAYS) {
      if (window.VP_OVERLAYS.modeShapes)  this.drawModeShapeOverlay(modalState, mdof);
      if (window.VP_OVERLAYS.modalEnergy) this.drawModalEnergyOverlay(modalState, mdof);
      if (window.VP_OVERLAYS.phase)       this.drawPhaseOverlay(modalState, mdof);
    }
  }

  // ------------------------------------------------------------
  // _drawArcBody(sample, massColor, velocity)
  //
  // Draws one arc's visible body with velocity-dependent gradient.
  // Gradient: bgColor at outer ends, massColor near equilibrium.
  // Low velocity: arc stays dim (near background).
  // ------------------------------------------------------------
  _drawArcBody(sample, massColor, velocity) {
    const mc  = massColor;
    const bg  = this.bgColor;

    const minVelThreshold = 0.05;
    const maxExpectedVel  = 2.0;

    // At rest: draw arc in background color to mask coupling stitching behind it.
    if (velocity < minVelThreshold) {
      stroke(bg, bg, bg);
      this._strokePolyline(sample.top);
      this._strokePolyline(sample.bottom);
      return;
    }

    const velNorm  = Math.min(1,
      (velocity - minVelThreshold) / (maxExpectedVel - minVelThreshold)
    );
    const colorStart   = 1.0 - velNorm * (1.0 - 0.2);
    const maxIntensity = 0.1 + velNorm * 0.9;

    // Each hemisphere: index 0 = outer (dim), last = inner near eq (bright).
    const drawHalf = (pts) => {
      if (pts.length < 2) return;
      for (let i = 0; i < pts.length - 1; i++) {
        const segFrac = (i + 0.5) / (pts.length - 1);
        let t = 0;
        if (segFrac > colorStart) {
          t = (segFrac - colorStart) / (1 - colorStart);
        }
        const r = Math.round(bg + t * maxIntensity * (mc[0] - bg));
        const g = Math.round(bg + t * maxIntensity * (mc[1] - bg));
        const b = Math.round(bg + t * maxIntensity * (mc[2] - bg));
        stroke(r, g, b);
        line(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      }
    };

    drawHalf(sample.top);
    drawHalf(sample.bottom);
  }

  // ------------------------------------------------------------
  // _drawArcBodyGray(sample)
  //
  // Draws an arc in solid 50% gray (RGB 128, 128, 128).
  // Used for ground-spring hover feedback -- shows the arc regardless of
  // velocity, and in a neutral color that doesn't suggest the mass color.
  // strokeWeight and strokeCap are already set by the caller (draw()).
  // ------------------------------------------------------------
  _drawArcBodyGray(sample) {
    stroke(128, 128, 128);
    this._strokePolyline(sample.top);
    this._strokePolyline(sample.bottom);
  }


  // ------------------------------------------------------------
  // _drawX(x, y, armLen)
  //
  // Draws a small diagonal X centered at (x, y) with arm length armLen.
  // Used to mark the arc/buffer intersection for ground-spring toggle.
  // strokeWeight and stroke color must be set by the caller.
  // ------------------------------------------------------------
  _drawX(x, y, armLen) {
    const a = armLen;
    line(x - a, y - a, x + a, y + a);
    line(x + a, y - a, x - a, y + a);
  }

  // ------------------------------------------------------------
  // _strokePolyline(pts)  -- draws line segments through {x,y} array.
  // ------------------------------------------------------------
  _strokePolyline(pts) {
    for (let i = 0; i < pts.length - 1; i++) {
      line(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    }
  }

  // ------------------------------------------------------------
  // _drawArcEndCircles(layout, arcBounds, physAngle, cr, massColor,
  //                    isFixed, isForced)
  //
  // Draws the two end circles (top and bottom of visible arc).
  // Tangent rule:
  //   top circle center    = min(physAngle - offset, pi + offset)
  //   bottom circle center = max(physAngle + offset, pi - offset)
  //
  // Constant size cr = this.endCircleRadius (no mass scaling in v0.15).
  //
  // Rendering modes:
  //   isFixed -- white stroke, black fill (mass is held as boundary condition)
  //   normal  -- no stroke, mass color fill (forced or free, same end circles)
  // ------------------------------------------------------------
  _drawArcEndCircles(layout, arcBounds, physAngle, cr, massColor, isFixed) {
    const { side, centerX: cx, centerY: cy, radius: r } = layout;
    const offset = cr / r;

    const topCenter    = Math.min(physAngle - offset, Math.PI + offset);
    const bottomCenter = Math.max(physAngle + offset, Math.PI - offset);

    const topPt = this.getArcPoint(side, cx, cy, r, topCenter);
    const botPt = this.getArcPoint(side, cx, cy, r, bottomCenter);

    if (isFixed) {
      // Fixed mass: white outline, black fill -- signals boundary condition.
      stroke(255);
      strokeWeight(2 * this.s);
      fill(0);
      circle(topPt.x, topPt.y, cr * 2);
      circle(botPt.x, botPt.y, cr * 2);
    } else {
      // Normal or kinematically forced: end circles always use mass color.
      noStroke();
      fill(massColor[0], massColor[1], massColor[2]);
      circle(topPt.x, topPt.y, cr * 2);
      circle(botPt.x, botPt.y, cr * 2);
    }
  }

  // ------------------------------------------------------------
  // _drawArcArcCoupling(lA, boundsA, physAngleA, crA,
  //                     lB, boundsB, physAngleB, crB)
  //
  // X-crosshatch coupling between two arc masses (any side combination).
  // Uses getArcPoint() so left/right mirroring is handled automatically.
  // Works for left-left, right-right, and left-right pairs.
  //
  // Horizontal-edge logic:
  //   Each arc clips at a different y because they have different radii and
  //   (potentially) different centers. To make the outer edge of the
  //   crosshatch flat (horizontal), we find the shared y limit, then
  //   recover a per-arc outer angle from that y.
  //
  //   Top hemisphere (arcs pass through canvas bottom, sin > 0):
  //     yTip = cy + r * sin(arcTop)  -- y at canvas-edge clip
  //     yShared = min(yA_tip, yB_tip) -- tighter (smaller y = less extended)
  //     angOuter = pi - arcsin((yShared - cy) / r) for each arc
  //
  //   Bottom hemisphere (arcs pass through canvas top, sin < 0):
  //     yShared = max(yA_tip, yB_tip) -- tighter (larger y = less extended)
  //     angOuter = pi - arcsin((yShared - cy) / r) [arcsin of negative = angle > pi]
  // ------------------------------------------------------------
  _drawArcArcCoupling(lA, boundsA, physAngleA, crA,
                      lB, boundsB, physAngleB, crB) {
    const eq      = Math.PI;
    const offsetA = crA / lA.radius;
    const offsetB = crB / lB.radius;
    const cyA     = lA.centerY;
    const cyB     = lB.centerY;
    const rA      = lA.radius;
    const rB      = lB.radius;

    // -- Top hemisphere --
    // sin(arcTop) > 0 (arcTop in (0, pi)), so yTip > cy (below center on screen).
    // Tighter clip = smaller yTip (arc that doesn't extend as far down).
    const yA_top     = cyA + rA * Math.sin(boundsA.arcTop);
    const yB_top     = cyB + rB * Math.sin(boundsB.arcTop);
    const yTop       = Math.min(yA_top, yB_top);
    // Recover angle: theta = pi - arcsin((y - cy) / r), clamped to valid range.
    const sinA_top   = Math.max(-1, Math.min(1, (yTop - cyA) / rA));
    const sinB_top   = Math.max(-1, Math.min(1, (yTop - cyB) / rB));
    const angOuterA_top = Math.PI - Math.asin(sinA_top);
    const angOuterB_top = Math.PI - Math.asin(sinB_top);

    // Inner angle = just inside the end circle, clamped to the outer clip so
    // that when a mass is over-displaced the stitching converges to the edge
    // point rather than disappearing.  Math.max keeps inner >= outer (top hemi).
    const topInnerA  = Math.max(Math.min(physAngleA - offsetA, eq + offsetA), angOuterA_top);
    const topInnerB  = Math.max(Math.min(physAngleB - offsetB, eq + offsetB), angOuterB_top);

    // Draw whenever at least one arc has a non-degenerate span.  Degenerate
    // arcs (inner == outer) converge to a single edge point -- intentional.
    if (topInnerA > angOuterA_top + 0.001 || topInnerB > angOuterB_top + 0.001) {
      this._drawArcCouplingHalf(
        lA.side, lA.centerX, cyA, rA,
        lB.side, lB.centerX, cyB, rB,
        angOuterA_top, angOuterB_top, topInnerA, topInnerB
      );
    }

    // -- Bottom hemisphere --
    // sin(arcBottom) < 0 (arcBottom in (pi, 2*pi)), so yTip < cy (above center).
    // Tighter clip = larger yTip (arc that doesn't extend as far up).
    const yA_bot     = cyA + rA * Math.sin(boundsA.arcBottom);
    const yB_bot     = cyB + rB * Math.sin(boundsB.arcBottom);
    const yBot       = Math.max(yA_bot, yB_bot);
    const sinA_bot   = Math.max(-1, Math.min(1, (yBot - cyA) / rA));
    const sinB_bot   = Math.max(-1, Math.min(1, (yBot - cyB) / rB));
    // arcsin of negative value gives negative angle; pi - negative = angle > pi (correct)
    const angOuterA_bot = Math.PI - Math.asin(sinA_bot);
    const angOuterB_bot = Math.PI - Math.asin(sinB_bot);

    // Math.min keeps inner <= outer (bottom hemi angles increase past pi toward 2*pi).
    const botInnerA  = Math.min(Math.max(physAngleA + offsetA, eq - offsetA), angOuterA_bot);
    const botInnerB  = Math.min(Math.max(physAngleB + offsetB, eq - offsetB), angOuterB_bot);

    if (botInnerA < angOuterA_bot - 0.001 || botInnerB < angOuterB_bot - 0.001) {
      this._drawArcCouplingHalf(
        lA.side, lA.centerX, cyA, rA,
        lB.side, lB.centerX, cyB, rB,
        angOuterA_bot, angOuterB_bot, botInnerA, botInnerB
      );
    }
  }

  // ------------------------------------------------------------
  // _drawArcCouplingHalf(sideA, cxA, cyA, rA, sideB, cxB, cyB, rB,
  //                      angOuterA, angOuterB, angInnerA, angInnerB)
  //
  // X-crosshatch for one hemisphere of a coupling pair.
  // Arc A sampled from angOuterA to angInnerA.
  // Arc B sampled from angOuterB to angInnerB.
  // Separate outer angles per arc ensure the outer edge is horizontal.
  // getArcPoint() handles the side-specific x-mirror.
  // ------------------------------------------------------------
  _drawArcCouplingHalf(sideA, cxA, cyA, rA,
                       sideB, cxB, cyB, rB,
                       angOuterA, angOuterB, angInnerA, angInnerB) {
    const n = this.arcSteps;
    for (let k = 0; k < n; k++) {
      const t0 = k / n;
      const t1 = (k + 1) / n;

      // Each arc travels its own outer-to-inner range independently.
      const A0 = this.getArcPoint(sideA, cxA, cyA, rA, lerp(angOuterA, angInnerA, t0));
      const A1 = this.getArcPoint(sideA, cxA, cyA, rA, lerp(angOuterA, angInnerA, t1));
      const B0 = this.getArcPoint(sideB, cxB, cyB, rB, lerp(angOuterB, angInnerB, t0));
      const B1 = this.getArcPoint(sideB, cxB, cyB, rB, lerp(angOuterB, angInnerB, t1));

      line(A0.x, A0.y, B1.x, B1.y);
      line(A1.x, A1.y, B0.x, B0.y);
    }
  }

  // ------------------------------------------------------------
  // drawCursor(toolName, x, y)
  //
  //   pointer   --> crosshair
  //   hold      --> open circle
  //   delete    --> X mark
  //   kinematic --> solid white circle
  //     (v0.14 had 'forcing' here -- corrected to 'kinematic')
  // ------------------------------------------------------------
  drawCursor(toolName, x, y) {
    stroke(255);
    strokeWeight(1.5 * this.s);
    noFill();

    if (toolName === 'pointer') {
      const size = 24 * this.s;
      line(x - size / 2, y, x + size / 2, y);
      line(x, y - size / 2, x, y + size / 2);
    } else if (toolName === 'hold') {
      circle(x, y, 24 * this.s);
    } else if (toolName === 'delete') {
      const size = 24 * this.s;
      line(x - size / 2, y - size / 2, x + size / 2, y + size / 2);
      line(x - size / 2, y + size / 2, x + size / 2, y - size / 2);
    } else if (toolName === 'kinematic') {
      fill(255);
      noStroke();
      circle(x, y, 12 * this.s);
    }
  }

  // ------------------------------------------------------------
  // ------------------------------------------------------------
  // _drawModalForcingRingBehind(layout, bounds)
  //
  // Draws a thick white semi-transparent outline arc behind the arc body,
  // coupling stitching, and end circles, indicating prescribed-displacement
  // forcing on this mass ('f' key feature).
  //
  // Wider than the arc body so it peeks out as a glowing outline.
  // arcStrokeWeight: normal arc thickness (includes end-circle diameter).
  // ringWeight: ~2.2x normal -- adds ~radiusGap/3 glow on each side.
  //
  // Called from draw() BEFORE coupling and arc body loops so it is visually
  // underneath everything else.
  // ------------------------------------------------------------
  _drawModalForcingRingBehind(layout, bounds) {
    if (!layout || !bounds) return;

    const { side, centerX: cx, centerY: cy, radius: r } = layout;

    // Ring is roughly 2.2x the arc body stroke so it reads as a thick outline.
    const ringWeight = this.arcStrokeWeight * 2.2;

    stroke(255, 255, 255, 160);   // white, semi-transparent
    strokeWeight(ringWeight);
    strokeCap(ROUND);
    noFill();

    // Trace the full visible arc from arcTop to arcBottom.
    beginShape();
    for (let i = 0; i <= this.arcSteps; i++) {
      const ang = lerp(bounds.arcTop, bounds.arcBottom, i / this.arcSteps);
      const pt  = this.getArcPoint(side, cx, cy, r, ang);
      vertex(pt.x, pt.y);
    }
    endShape();

    strokeCap(SQUARE);
  }

  // ------------------------------------------------------------
  // drawForcingDiagnostics(forcingState, isDragging, dragMassIndex, mdof)
  //
  // Shows the kinematic driving frequency and the free-subsystem natural
  // frequencies.  Only visible when at least one forced mass has omega > 0
  // (i.e. the user has set a kinematic frequency, not just a static hold).
  //
  // Layout (top-left, y = 80*s downward):
  //   f  kinematic  = X.XX Hz    (driveSize = 2 * modeSize)
  //   f_1 = X.XX Hz
  //   f_2 = X.XX Hz
  //   ...
  //
  // "kinematic" is drawn as a pseudo-subscript: smaller text, shifted down.
  // Natural frequency lines highlight red when near resonance (+/-5%).
  // ------------------------------------------------------------
  drawForcingDiagnostics(forcingState, isDragging, dragMassIndex, mdof) {
    if (!this.showForcingDiagnostics) return;
    if (!forcingState || forcingState.size === 0) return;

    // Only show while the user is actively holding / dragging click-2.
    if (!isDragging || dragMassIndex < 0 || !forcingState.has(dragMassIndex)) return;

    const params    = forcingState.get(dragMassIndex);
    const drivingHz = params.omega / (2 * Math.PI);

    let reducedOmega = [];
    if (mdof) reducedOmega = mdof.getReducedFrequencies(forcingState);

    const textX      = 20 * this.s;
    const driveSize  = 18 * this.s;   // kinematic line
    const modeSize   =  9 * this.s;   // natural-frequency lines (half of drive)
    const kSubSize   = 10 * this.s;   // "kinematic" pseudo-subscript
    const kSubDrop   =  5 * this.s;   // downward shift for kinematic subscript
    const nSubSize   =  6 * this.s;   // mode-number pseudo-subscript
    const nSubDrop   =  3 * this.s;   // downward shift for mode-number subscript
    const lineHeight = 13 * this.s;
    let   cursorY    = 80 * this.s;

    noStroke();
    textAlign(LEFT, TOP);
    textFont('monospace');

    // -- Kinematic frequency: f(subscript kinematic) = X.XX Hz --
    fill(255);
    textSize(driveSize);
    text('f', textX, cursorY);
    const fKW = textWidth('f');

    textSize(kSubSize);
    text('kinematic', textX + fKW + this.s, cursorY + kSubDrop);
    const kSubW = textWidth('kinematic');

    textSize(driveSize);
    text(' = ' + drivingHz.toFixed(2) + ' Hz', textX + fKW + kSubW + this.s, cursorY);

    cursorY += driveSize + 6 * this.s;

    // -- Natural frequency lines: f(subscript n) = X.XX Hz --
    for (let n = 0; n < reducedOmega.length; n++) {
      const fnHz = reducedOmega[n] / (2 * Math.PI);
      let nearResonance = false;
      for (const [, p] of forcingState) {
        if (p.omega > 0) {
          const ratio = p.omega / reducedOmega[n];
          if (ratio > 0.95 && ratio < 1.05) { nearResonance = true; break; }
        }
      }
      fill(nearResonance ? color(255, 100, 100) : color(200, 200, 200));

      textSize(modeSize);
      text('f', textX, cursorY);
      const fNW = textWidth('f');

      textSize(nSubSize);
      text(String(n + 1), textX + fNW, cursorY + nSubDrop);
      const nSubW = textWidth(String(n + 1));

      textSize(modeSize);
      text(' = ' + fnHz.toFixed(2) + ' Hz', textX + fNW + nSubW, cursorY);

      cursorY += lineHeight;
    }

    textAlign(LEFT, BASELINE);
  }

  // ------------------------------------------------------------
  // drawAddMassHover(side)
  //
  // Draws a ghost preview of the mass that would appear if the user
  // clicked the add-mass zone on the given side.
  //
  // Only two end circles are drawn, tangent to each other at the
  // equilibrium point (eqX, canvasHeight/2).  At equilibrium:
  //   top circle center:    (eqX, cy + cr)   -- touches cy from below
  //   bottom circle center: (eqX, cy - cr)   -- touches cy from above
  // They share exactly one point: (eqX, cy).
  // ------------------------------------------------------------
  drawAddMassHover(side) {
    if (!side) return;
    const ml = window.massLayout;
    if (!ml) return;

    const layout = ml.previewNextMass(side);
    if (!layout) return;

    // Equilibrium x: where the arc crosses the horizontal centre line.
    //   Right arc: eqX = centerX - radius
    //   Left  arc: eqX = centerX + radius
    const eqX = layout.side === 'right'
      ? layout.centerX - layout.radius
      : layout.centerX + layout.radius;
    const cy  = layout.centerY;   // = canvasHeight / 2
    const cr  = this.endCircleRadius;

    noStroke();
    fill(128, 128, 128, 180);

    // Top circle sits below centre (screen y increases downward).
    circle(eqX, cy + cr, cr * 2);
    // Bottom circle sits above centre.
    circle(eqX, cy - cr, cr * 2);
  }

  // ------------------------------------------------------------
  // drawCouplingHoverIndicator(hoverPair, mdof)
  //
  // Draws a '<-->' text arrow at the midpoint of the hovered coupling gap.
  // Color differs depending on whether coupling already exists:
  //   No coupling yet: dim gray  -- "click to add"
  //   Coupling exists: bright    -- "click to remove"
  // hoverPair is null when no gap is hovered; nothing is drawn.
  // ------------------------------------------------------------
  drawCouplingHoverIndicator(hoverPair, mdof) {
    if (!hoverPair) return;

    const hasCoupling = mdof && mdof.hasCoupling(hoverPair.iA, hoverPair.iB);

    noStroke();
    // Bright accent when coupling exists (removal hint); dim when adding.
    if (hasCoupling) {
      fill(160, 200, 255);   // blue-ish -- "click to remove"
    } else {
      fill(140, 140, 140);   // gray -- "click to add"
    }

    textAlign(CENTER, CENTER);
    textSize(14 * this.s);
    textFont('monospace');
    text('<-->', hoverPair.midX, hoverPair.midY);
  }

  // ------------------------------------------------------------
  // drawModeShapeOverlay(modalState, mdof)
  //
  // Draws every mode shape as a colored polyline.
  // For each mode n, a point is placed at:
  //   x = equilibrium x of mass i (visual order, left to right)
  //   y = canvasHeight/2 - Phi[i][n] * scale_px
  // Positive Phi component = above the centre line.
  // Negative Phi component = below.
  //
  // Each mode line is drawn with opacity proportional to its current
  // share of total modal energy: a dominant mode is bright, a silent
  // mode fades to near-invisible.  The minimum alpha (20) keeps all
  // mode shapes faintly legible even when the system is nearly at rest.
  //
  // Scale: the maximum absolute value across all Phi[i][n] maps to
  // scale_px reference pixels.  This is constant across all modes so
  // spatial amplitudes can be compared directly.
  // ------------------------------------------------------------
  drawModeShapeOverlay(modalState, mdof) {
    if (!mdof || !mdof.Phi || !window.massLayout) return;

    const ml     = window.massLayout;
    // Nmodes: number of free (non-fixed) modes.  When masses are fixed,
    // mdof.Phi is Nfree x Nfree (local indices), so we must NOT use
    // mdof.size() here -- that returns totalN and would index out of bounds.
    const Nmodes = mdof.omega.length;
    if (Nmodes === 0) return;   // all masses fixed -- nothing to draw
    const midY   = this.canvasHeight / 2;

    // scale_px: visual height (in pixels) for a component of amplitude 1.0
    const scale_px = 55 * this.s;

    // Find max absolute Phi component across ALL modes so scale is consistent.
    // Phi is Nfree x Nfree; iterate local indices 0..Nmodes-1.
    let maxPhi = 0;
    for (let n = 0; n < Nmodes; n++) {
      for (let li = 0; li < Nmodes; li++) {
        maxPhi = Math.max(maxPhi, Math.abs(mdof.Phi[li][n]));
      }
    }
    if (maxPhi < 1e-10) return;   // degenerate: no valid mode shapes
    const scale = scale_px / maxPhi;

    // Modal energies drive per-mode opacity.
    const energies    = modalState.getModalEnergies();
    const totalEnergy = energies.reduce((s, e) => s + e, 0);

    for (let n = 0; n < Nmodes; n++) {
      // Mode color: lerps from yellow (mode 1) to red (highest mode).
      const mc = getModeColor(n, Nmodes);

      // Fraction of total energy in this mode.
      // At rest (totalEnergy ~ 0): show all modes at minimum alpha.
      const fraction = totalEnergy > 1e-12
        ? Math.min(1, energies[n] / totalEnergy)
        : 1 / Nmodes;

      // Alpha: 20 (silent) to 220 (dominant).  sqrt gives perceptual linearity.
      const alpha = Math.round(20 + Math.sqrt(fraction) * 200);

      // Collect screen points in visual order (left to right on screen).
      // Fixed masses are skipped -- they have no Phi component.
      const pts = [];
      for (let vi = 0; vi < ml.visualOrder.length; vi++) {
        const physIdx = ml.visualOrder[vi];
        const layout  = ml.get(physIdx);
        if (!layout) continue;

        // globalToFree maps global physics index --> local free index.
        // Fixed masses are absent from the map -- they contribute phi=0
        // (a boundary condition node on the mode shape line).
        const li = mdof.globalToFree.get(physIdx);

        // Equilibrium x: where the arc crosses the horizontal centre line.
        const eqX = layout.side === 'right'
          ? layout.centerX - layout.radius
          : layout.centerX + layout.radius;

        if (li === undefined) {
          // Fixed mass: boundary node at phi=0 (equilibrium on screen).
          // isFixed=true tells the draw loop to skip the dot for this point.
          pts.push({ x: eqX, y: midY, isFixed: true });
        } else {
          // Phi[li][n]: component of mode n at the free mass with local index li.
          // Positive -> point above midline (smaller y in screen coords).
          const phi = mdof.Phi[li][n];
          pts.push({ x: eqX, y: midY - phi * scale, isFixed: false });
        }
      }

      // Draw polyline connecting all node points (including fixed zero-nodes).
      stroke(mc[0], mc[1], mc[2], alpha);
      strokeWeight(1.5 * this.s);
      noFill();
      if (pts.length >= 2) {
        beginShape();
        for (const pt of pts) vertex(pt.x, pt.y);
        endShape();
      }

      // Draw filled circles only at free-mass nodes (not fixed boundary nodes).
      noStroke();
      fill(mc[0], mc[1], mc[2], alpha);
      for (const pt of pts) {
        if (!pt.isFixed) circle(pt.x, pt.y, 6 * this.s);
      }
    }

    // Reset text alignment in case caller draws text next.
    textAlign(LEFT, BASELINE);
  }

  // ------------------------------------------------------------
  // drawModalEnergyOverlay(modalState, mdof)
  //
  // Horizontal bar chart of modal energies, RIGHT side, vertically centred.
  // Each bar grows LEFTWARD from a fixed right anchor.
  // The entire chart block is centred vertically on the canvas so it
  // rebalances automatically as modes are added or removed.
  //
  // Layout per row (working right-to-left):
  //   [freq label]  |  [===bar===]  |  [mode #]  |  [padR]
  //
  //   modeRightX = canvasWidth - padR           right edge of mode# column
  //   barRightX  = modeRightX - labelW - barGap right edge of bars (bars grow left)
  //   freqEndX   = barRightX - maxBarW - freqGap right-edge of frequency text
  //
  // Column headers:
  //   "Mode #"    right-aligned at modeRightX, just above startY
  //   "Frequency" right-aligned at freqEndX,   just above startY
  //
  // Absorber row (when VP_STATE.absorberResonanceHz is set):
  //   Extra row below the last mode row.
  //   "Absorber" right-aligned in the mode# column.
  //   Absorber Hz right-aligned in the freq column.
  //
  // Colors: yellow (mode 1) lerps to red (highest mode) via getModeColor().
  // Bars are zero-width (not hidden) when all energies are zero -- overlay
  // stays visible at rest so users can see mode count and frequencies.
  // ------------------------------------------------------------
  drawModalEnergyOverlay(modalState, mdof) {
    const energies = modalState.getModalEnergies();
    const N        = energies.length;
    if (N === 0) return;

    const maxEnergy = Math.max(...energies);
    // Do NOT return early when maxEnergy is zero -- keep drawing the skeleton
    // (mode numbers and frequency labels) so the overlay stays visible after
    // vpZeroState(). Bars simply have zero width when all energies are zero.
    const hasEnergy = (maxEnergy >= 1e-12);

    // ---- Dimensions ----
    const textSz  = 11 * this.s;   // mode numbers and frequency text
    const hdrSz   =  9 * this.s;   // column header text
    const barH    = 12 * this.s;   // bar height (one row)
    const maxBarW = 45 * this.s;   // bar width at full scale (E = maxEnergy)
    const gap     =  3 * this.s;   // vertical gap between rows
    const padR    =  8 * this.s;   // right margin from canvas edge
    const labelW  = 20 * this.s;   // column width reserved for mode numbers
    const barGap  =  4 * this.s;   // gap between bar right-edge and mode# left-edge
    const freqGap =  5 * this.s;   // gap between freq text right-edge and bar left-edge

    // ---- X positions (anchored to right edge) ----
    const modeRightX = this.canvasWidth - padR;          // right edge of mode# column
    const barRightX  = modeRightX - labelW - barGap;     // right edge of bar area
    const freqEndX   = barRightX - maxBarW - freqGap;    // right edge of freq text

    // ---- Vertical centering ----
    // Absorber row needs one extra slot if it will be shown.
    const vpState          = window.VP_STATE;
    const absorberHz       = vpState && vpState.absorberResonanceHz;
    const showAbsorberRow  = !!(absorberHz);
    const nRows            = N + (showAbsorberRow ? 1 : 0);
    const totalChartH      = nRows * barH + Math.max(0, nRows - 1) * gap;
    const startY           = (this.canvasHeight - totalChartH) / 2;

    noStroke();
    textFont('monospace');

    // ---- Column headers just above the chart block ----
    const hdrY = startY - 3 * this.s;   // baseline for header text (BOTTOM alignment)
    fill(200, 200, 200, 120);
    textSize(hdrSz);

    // "Mode #" header above the mode-number column.
    textAlign(RIGHT, BOTTOM);
    text('Mode #', modeRightX, hdrY);

    // "Frequency" header above the frequency column.
    textAlign(RIGHT, BOTTOM);
    text('Frequency', freqEndX, hdrY);

    // ---- Mode rows ----
    for (let n = 0; n < N; n++) {
      const mc       = getModeColor(n, N);
      // fraction: 0 when all energies are zero (hasEnergy false), avoids divide-by-zero.
      const fraction = hasEnergy ? energies[n] / maxEnergy : 0;
      const barW     = fraction * maxBarW;
      // rowY: top edge of this row's bar.
      const rowY    = startY + n * (barH + gap);
      const rowMidY = rowY + barH / 2;   // vertical centre of bar row

      // Bar rectangle: grows LEFTWARD from barRightX.
      fill(mc[0], mc[1], mc[2], 180);
      rect(barRightX - barW, rowY, barW, barH);

      // Mode number: right-aligned in mode# column, vertically centred on row.
      fill(mc[0], mc[1], mc[2], 200);
      textSize(textSz);
      textAlign(RIGHT, CENTER);
      text(n + 1, modeRightX, rowMidY);

      // Frequency label: right-aligned at freqEndX, vertically centred on row.
      // Only shown when mdof is present and omega is populated.
      if (mdof && mdof.omega && mdof.omega[n] !== undefined) {
        const freqHz = mdof.omega[n] / (2 * Math.PI);
        fill(mc[0], mc[1], mc[2], 140);
        textSize(textSz);
        textAlign(RIGHT, CENTER);
        text(freqHz.toFixed(2) + ' Hz', freqEndX, rowMidY);
      }
    }

    // ---- Absorber row (absorber scenario only, one row below last mode) ----
    // Shown only when VP_STATE.absorberResonanceHz is set (cleared by the sketch
    // whenever forcing is turned off, a mass is added, a ground spring is added,
    // or a new scenario is loaded).
    if (showAbsorberRow) {
      const absRowY   = startY + N * (barH + gap);   // top of absorber row
      const absMidY   = absRowY + barH / 2;           // vertical centre

      // "Absorber" label in the mode# column (right-aligned like mode numbers).
      fill(220, 200, 80, 200);
      textSize(textSz);
      textAlign(RIGHT, CENTER);
      text('Absorber', modeRightX, absMidY);

      // Absorber Hz in the frequency column (right-aligned like mode frequencies).
      textAlign(RIGHT, CENTER);
      text(absorberHz.toFixed(3) + ' Hz', freqEndX, absMidY);
    }

    textAlign(LEFT, BASELINE);
  }

  // ------------------------------------------------------------
  // drawPhaseOverlay(modalState, mdof)
  //
  // Draws a phase-position circle on the right side of the canvas.
  //
  // Each mass is shown as a line from the circle center to the rim,
  // at angle theta_i = atan2(v_i / omega_ref, x_i).  This represents
  // where the mass sits in its oscillation cycle (0 = max positive
  // displacement, pi/2 = passing through zero moving down, etc.).
  // omega_ref = mdof.omega[0] normalises velocity to displacement units
  // so that a purely-oscillating mass traces a circle, not an ellipse.
  //
  // Line color = mass color (same palette as arc bodies).
  // Line opacity modulates with amplitude: quiet masses fade.
  //
  // If modal forcing is active (VP_STATE.modalForcingActive), a thick
  // white line is drawn at the current force phase omega_f * t.
  //
  // Geometry is fixed regardless of how many masses are on screen:
  // the circle always sits in the space to the right of where the
  // maximum-capacity right mass WOULD be placed.
  // ------------------------------------------------------------
  drawPhaseOverlay(modalState, mdof) {
    if (!mdof || !window.massLayout) return;

    const ml   = window.massLayout;
    const dims = ml.dims;

    // Fixed geometry: minimum left-mass equilibrium x at full capacity.
    // Left arc k: eq_x = midX - rg/2 - k * rg, where k = cap-1 for outermost.
    const midX    = ml.canvasMidX;
    const rg      = dims.radiusGap;
    const cap     = dims.maxPerSide;
    const eqXmin  = midX - rg / 2 - (cap - 1) * rg;

    // Space available to the left of the max-left-mass position.
    const xSpace = eqXmin;
    if (xSpace < 20) return;   // canvas too narrow to draw anything useful

    const cx      = eqXmin / 2;                  // circle center x (midpoint of left gap)
    const cy      = this.canvasHeight / 2;        // circle center y (canvas midline)
    const rPhase  = (xSpace / 2) * 0.82;          // radius: 82% of available half-width

    // Reference frequency for velocity normalisation.
    // Without this, a mass oscillating at omega would produce an ellipse
    // in (x, v) space rather than a circle.
    const omegaRef = (mdof.omega && mdof.omega.length > 0 && mdof.omega[0] > 0.01)
      ? mdof.omega[0]
      : 2 * Math.PI;   // 1 Hz fallback

    // ---- Label ----
    noStroke();
    fill(120, 120, 120, 160);
    textFont('monospace');
    textSize(9 * this.s);
    textAlign(CENTER, BOTTOM);
    text('Phase Angle', cx, cy - rPhase - 4 * this.s);

    // ---- Circle outline ----
    noFill();
    stroke(80, 80, 80, 150);
    strokeWeight(1 * this.s);
    ellipse(cx, cy, rPhase * 2, rPhase * 2);

    // ---- Mass phase lines ----
    const displacements = modalState.getDisplacements();
    const velocities    = modalState.getVelocities();
    const N = mdof.size();

    strokeCap(ROUND);

    for (let i = 0; i < N; i++) {
      const xi       = displacements[i];
      const vi       = velocities[i];
      const normVi   = vi / omegaRef;   // velocity normalised to displacement units

      // Amplitude in phase space: distance from origin.  Used to modulate opacity
      // so a nearly-still mass fades out rather than leaving a ghost line.
      const amplitude   = Math.sqrt(xi * xi + normVi * normVi);
      const normAmp     = Math.min(1, amplitude / 0.5);   // full opacity at amplitude 0.5
      const alpha       = Math.round(30 + normAmp * 210);

      // Phase angle.  For x(t) = A*cos(omega*t), normVi = -A*sin(omega*t).
      // atan2(normVi, xi) = atan2(-sin, cos) = -omega*t --> CW rotation.
      // Negate normVi so atan2(-normVi, xi) = atan2(sin, cos) = omega*t --> CCW,
      // matching the force-phase line and standard phasor convention.
      const theta = Math.atan2(-normVi, xi);

      const mc = this.getMassColor(i);
      stroke(mc[0], mc[1], mc[2], alpha);
      strokeWeight(3 * this.s);

      // Tip of the line at the circle rim.
      const tipX = cx + rPhase * Math.cos(theta);
      const tipY = cy - rPhase * Math.sin(theta);   // subtract: screen y grows downward
      line(cx, cy, tipX, tipY);
    }

    // ---- Force phase line (modal forcing only) ----
    // f(t) = F * sin(omega_f * t), so the force phasor angle is omega_f * t.
    // Drawn as a thick white line on top of the mass lines.
    const state = window.VP_STATE;
    if (state && state.modalForcingActive && state.forcingTime !== undefined
        && state.modalForcingHz > 0) {
      const omegaF  = state.modalForcingHz * 2 * Math.PI;
      const phaseF  = omegaF * state.forcingTime;   // angle advances at forcing frequency
      const fTipX   = cx + rPhase * Math.cos(phaseF);
      const fTipY   = cy - rPhase * Math.sin(phaseF);
      stroke(255, 255, 255, 220);
      strokeWeight(4.5 * this.s);
      line(cx, cy, fTipX, fTipY);
    }

    // Reset stroke state for callers.
    strokeCap(SQUARE);
    strokeWeight(1);
  }
}
