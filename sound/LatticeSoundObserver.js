/**
 * LatticeSoundObserver.js  (Step 6)
 *
 * Responsibility:
 * - One monosynth voice per lattice node
 * - Tonnetz pitch mapping: pitchHz = rootHz * (3/2)^q * (5/4)^r, octave-folded
 * - Displacement-driven amplitude: |disp[i]| controls the gain each frame
 * - Static spatial panning from node screenX position
 *
 * NOT allowed to:
 * - Modify latticeDef or modalState
 * - Advance physics time
 * - Do hit-testing or rendering
 *
 * Audio chain per node i:
 *   Oscillator (sine, fixed tonnetz pitch)
 *     --> Gain    (starts at 0; driven by |disp[i]| each frame)
 *     --> Bus     (master Tone.Gain)
 *     --> Tone.Destination
 *
 * Gain mapping each frame (two-step):
 *   rawGain = clamp( |disp[i]| / MAX_DISP * MAX_GAIN,  0, MAX_GAIN )
 *   norm    = rawGain / MAX_GAIN                         (0..1)
 *   target  = MAX_GAIN * norm^GAIN_EXPONENT              (power-law shaping)
 *   applied with rampTo(target, RAMP_TIME) to avoid zipper noise.
 * Cubic power-law (exponent=3) concentrates audible presence into the 1-3
 * most active nodes; background rumble from many nodes at small displacement
 * stays quiet because small norms are cubed before rescaling.
 *
 * Pitch table (precomputed, never changes):
 *   pitchTable[i] = rootHz * (3/2)^q * (5/4)^r, octave-folded into [110, 1760] Hz.
 *   Center node (q=0, r=0) = 440 Hz (A4).
 *   Moving +1 along q = perfect fifth up.
 *   Moving +1 along r = major third up.
 *   The implicit dq+dr=0 diagonal = minor third (3/2 / 5/4 = 6/5).
 *
 * ensureAudioGraph() must be called from a user gesture (click or keypress)
 * to satisfy browser autoplay policy. It is safe to call multiple times --
 * it exits early if this.ready is already true.
 */

class LatticeSoundObserver {

  /**
   * constructor
   * @param {LatticeDefinition} latticeDef -- owns node positions (q, r, screenX)
   */
  constructor(latticeDef) {
    this.latticeDef = latticeDef;
    const N = latticeDef.size();

    // --- Readiness flag (set true by ensureAudioGraph) ---
    this.ready = false;

    // --- Tone.js nodes (null until ensureAudioGraph runs) ---
    // oscs[i]  : Tone.Oscillator  -- sine wave at node i's tonnetz pitch
    // gains[i] : Tone.Gain        -- amplitude controlled by |disp[i]| each frame
    // bus      : Tone.Gain        -- master volume node, connects to Destination
    this.oscs    = new Array(N).fill(null);
    this.gains   = new Array(N).fill(null);
    this.bus     = null;

    // --- Gain parameters ---
    // MAX_VEL: physical velocity (units/s) that maps to full gain.
    // Gain is driven by |vel[i]| rather than |disp[i]| so that slow-drifting
    // masses (large displacement, near-zero velocity) stay silent.
    // Estimate: typical peak vel ~ omega_n * typical_disp ~ 6 * 0.5 = 3.
    // Tune upward if normal strikes sound too quiet, downward if they clip.
    this.MAX_VEL = 1.5;

    // MAX_GAIN: peak amplitude per voice (also used as the total budget ceiling,
    // see two-pass normalization in update()).  Scales down with shell count so
    // the total output stays consistent as the number of voices grows.
    // Halved from original values to stay below Tone.Destination's compressor knee
    // and avoid pumping distortion on loud multi-node strikes:
    //   1 shell  (7 nodes)  --> 0.40
    //   2 shells (19 nodes) --> 0.20
    //   3 shells (37 nodes) --> 0.12
    const MAX_GAIN_BY_SHELLS = { 1: 0.40, 2: 0.20, 3: 0.12 };
    const shells = latticeDef.shells || 2;
    this.MAX_GAIN = MAX_GAIN_BY_SHELLS[shells] !== undefined
                    ? MAX_GAIN_BY_SHELLS[shells]
                    : 0.20;   // fallback for any unexpected shell count

    // RAMP_TIME: gain ramp in seconds. 80ms smooths envelope transitions more
    // than the previous 50ms, reducing zipper-noise artifacts from rapid gain
    // changes while still tracking the vibration envelope at the frame rate.
    this.RAMP_TIME = 0.08;

    // GAIN_EXPONENT: power-law exponent for gain shaping.
    // effectiveGain = MAX_GAIN * (rawGain / MAX_GAIN)^GAIN_EXPONENT
    // At exponent=3 (cubic):
    //   norm=1.0 (loudest) --> effectiveGain = MAX_GAIN        (100%)
    //   norm=0.5           --> effectiveGain = MAX_GAIN / 8    (12.5%)
    //   norm=0.2           --> effectiveGain = MAX_GAIN / 125  (0.8%)
    // This concentrates audible presence into the 1-3 most active nodes.
    // Background rumble from 19 nodes each at small displacement stays quiet
    // because the cubic law suppresses small values much more than linear or
    // quadratic: the sum of 19 nodes at norm=0.15 is 19 * (0.15^3) * MAX_GAIN
    // = 19 * 0.0034 * 0.40 = 0.026 total, well below the 0.40 peak.
    this.GAIN_EXPONENT = 3;

    // SILENCE_THRESH: velocities below this are treated as exactly zero to
    // avoid scheduling near-zero gain ramps on idle nodes. Prevents audio
    // scheduler buildup at rest when numerical residues are non-zero.
    this.SILENCE_THRESH = 0.004;

    // --- Precomputed pitch tables (fixed once, never rebuilt) ---
    // pitchTable[i]   : 5-limit just intonation Hz for node i
    // pitchTableET[i] : 12-TET Hz for node i (same root, tempered intervals)
    this.pitchTable   = this._buildPitchTable(latticeDef);
    this.pitchTableET = this._buildPitchTableET(latticeDef);

    // --- Tuning mode ---
    // 'ji' = 5-limit just intonation (default, original behaviour)
    // 'et' = 12-tone equal temperament
    this.tuningMode = 'ji';
  }

  // -------------------------------------------------------------------------
  // _buildPitchTable
  //
  // Precompute the tonnetz pitch for every node from its axial coordinates.
  //
  //   pitchHz = rootHz * (3/2)^q * (5/4)^r
  //
  // Then octave-fold into [minHz, maxHz] so all pitches land in the audible
  // range and the set spans a musically useful register.
  //
  //   root  = 440 Hz (A4)
  //   range = 110 Hz (A2) to 1760 Hz (A6)
  //
  // For a 2-shell (19-node) lattice with root A4:
  //   center  (q=0, r=0) = 440 Hz  (A4)
  //   +1 fifth  (q=1)    = 660 Hz  (E5)
  //   -1 fifth  (q=-1)   = 293 Hz  (D4, no fold needed)
  //   -2 fifths (q=-2)   = 196 Hz  (G3, no fold needed -- below D4 as expected)
  //   +1 third  (r=1)    = 550 Hz  (C#5 just)
  // -------------------------------------------------------------------------
  _buildPitchTable(latticeDef) {
    const rootHz = 440;   // A4 -- center node pitch.
    //   Root is A4 (not A3) so the chain of descending fifths (A->D->G->C->F)
    //   stays in range without octave-folding for the 2-shell lattice.
    //   With root=220 the note G (q=-2) folds from 97.78 Hz up to 195.56 Hz,
    //   landing ABOVE D (146.67 Hz) and breaking the expected descending order.
    //   With root=440 the same node lands at 195.56 Hz and D is at 293.33 Hz,
    //   so the chain A(440) > D(293) > G(196) correctly descends.
    const minHz  = 110;   // A2  -- fold down if below this (only outer 3-shell corners)
    const maxHz  = 1760;  // A6  -- fold up   if above this
    const table  = [];

    for (let i = 0; i < latticeDef.size(); i++) {
      const { q, r } = latticeDef.nodePositions[i];

      // 5-limit just intonation on the tonnetz:
      //   q steps along the fifth axis  (ratio 3/2 per step)
      //   r steps along the third axis  (ratio 5/4 per step)
      let hz = rootHz * Math.pow(3 / 2, q) * Math.pow(5 / 4, r);

      // Octave-fold: multiply or divide by 2 until in range.
      // With root=440 the entire 2-shell lattice fits in [110, 1760] without
      // folding.  Folds may still occur at extreme corners of the 3-shell lattice.
      while (hz > maxHz) hz /= 2;
      while (hz < minHz) hz *= 2;

      table[i] = hz;
    }

    return table;
  }

  // -------------------------------------------------------------------------
  // _buildPitchTableET
  //
  // Equal-temperament version of _buildPitchTable.
  // Same root (440 Hz, A4) and same octave-fold range [110, 1760] as the JI
  // table so the two tables are directly comparable: toggle between them and
  // the center node stays at 440 Hz while neighbours shift by comma amounts.
  //
  // Interval mapping (12-TET):
  //   q axis: +7 semitones per step  (tempered perfect fifth = 700 cents)
  //   r axis: +4 semitones per step  (tempered major third  = 400 cents)
  //
  // Formula:
  //   semitones = q * 7 + r * 4
  //   hz = rootHz * 2^(semitones / 12)
  //
  // Compared to JI: ET fifths are 2 cents narrow, ET major thirds are 14 cents
  // sharp.  The beating between formerly-pure JI intervals is audible on toggle.
  // -------------------------------------------------------------------------
  _buildPitchTableET(latticeDef) {
    const rootHz = 440;   // A4 -- same root as JI table
    const minHz  = 110;   // A2  (octave fold floor, same as JI)
    const maxHz  = 1760;  // A6  (octave fold ceiling, same as JI)
    const table  = [];

    for (let i = 0; i < latticeDef.size(); i++) {
      const { q, r } = latticeDef.nodePositions[i];

      // Total semitone offset from root in 12-TET.
      //   q = +1 --> E above A = +7 semitones  (700 cents, vs JI 702 cents)
      //   r = +1 --> C# above A = +4 semitones (400 cents, vs JI 386 cents)
      const semitones = q * 7 + r * 4;
      let hz = rootHz * Math.pow(2, semitones / 12);

      // Octave-fold into audible range (same logic as JI table).
      while (hz > maxHz) hz /= 2;
      while (hz < minHz) hz *= 2;

      table[i] = hz;
    }

    return table;
  }

  // -------------------------------------------------------------------------
  // setTuning(mode)
  //
  // Switch between just intonation ('ji') and equal temperament ('et').
  // If the audio graph is already running, retunes all oscillators immediately
  // by writing to osc.frequency.value -- an AudioParam assignment that takes
  // effect at the next render quantum (~2.7 ms at 48 kHz). No clicks, no gaps,
  // no graph rebuild required.
  //
  // @param {string} mode -- 'ji' or 'et'
  // -------------------------------------------------------------------------
  setTuning(mode) {
    if (mode !== 'ji' && mode !== 'et') return;
    this.tuningMode = mode;

    // Pick the pitch table for the new mode.
    const table = (mode === 'ji') ? this.pitchTable : this.pitchTableET;

    // Hot-retune all oscillators if the audio graph is already running.
    if (this.ready) {
      for (let i = 0; i < this.oscs.length; i++) {
        if (this.oscs[i]) {
          this.oscs[i].frequency.value = table[i];
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // ensureAudioGraph
  //
  // Build the Tone.js signal chain for all N nodes.  Must be called from a
  // user gesture (mousePressed, keyPressed) to satisfy browser autoplay policy.
  // Safe to call multiple times -- exits immediately if already ready.
  //
  // Audio context lifecycle:
  //   1. Tone.start() resumes the AudioContext if it is 'suspended' (iOS default).
  //   2. Once running, N oscillators are created at their tonnetz pitches and
  //      immediately started.  Each starts silent (gain = 0).
  //   3. update(disp) drives the gains from the first draw() call onward.
  // -------------------------------------------------------------------------
  async ensureAudioGraph() {
    if (this.ready) return;

    // Tone.start() resumes the browser AudioContext; required on first gesture.
    if (Tone.context.state !== 'running') {
      await Tone.start();
    }

    const N = this.latticeDef.size();

    // Master bus: a single gain node for overall volume.
    // Connecting to Tone.Destination routes all audio to speakers.
    this.bus = new Tone.Gain(0.9).toDestination();

    // Use whichever pitch table is active at graph-build time.
    // If the user has already toggled to ET before the first gesture, the
    // oscillators start at ET pitches.  setTuning() handles post-build retuning.
    const activePitchTable = (this.tuningMode === 'ji') ? this.pitchTable : this.pitchTableET;

    for (let i = 0; i < N; i++) {
      const hz = activePitchTable[i];

      // Sine oscillator at this node's tonnetz pitch.
      const osc  = new Tone.Oscillator({ frequency: hz, type: 'sine' });

      // Gain node starts at 0 (silent). update() ramps this each frame.
      const gain = new Tone.Gain(0);

      // Wire the chain: osc --> gain --> bus --> Destination (mono, no panner)
      osc.connect(gain);
      gain.connect(this.bus);

      osc.start();

      this.oscs[i]  = osc;
      this.gains[i] = gain;
    }

    this.ready = true;
  }

  // -------------------------------------------------------------------------
  // update(disp, vel)
  //
  // Called every draw() frame. Computes a target gain for each node from
  // |vel[i]|, then applies a total-gain budget so that N simultaneously
  // active voices scale back proportionally while a single active voice
  // retains full loudness.
  //
  // @param {number[]} disp -- physical displacements, length N (unused for gain
  //                           but kept for potential future use, e.g. pitch bend)
  // @param {number[]} vel  -- physical velocities,    length N (from modalState.getVelocities())
  //
  // Two-pass gain formula:
  //
  //   Pass 1 -- per-voice raw gain (velocity-driven, power-law shaped):
  //     rawGain[i] = MAX_GAIN * ( clamp(|vel[i]| / MAX_VEL, 0, 1) ) ^ GAIN_EXPONENT
  //     rawGain[i] = 0 if |vel[i]| < SILENCE_THRESH
  //
  //   Pass 2 -- total budget normalization:
  //     totalRaw    = sum_i( rawGain[i] )
  //     budgetScale = MAX_GAIN / totalRaw   if totalRaw > MAX_GAIN
  //                 = 1.0                   otherwise
  //     targetGain[i] = rawGain[i] * budgetScale
  //
  // Effect:
  //   - Single active voice at full velocity: totalRaw = MAX_GAIN,
  //     budgetScale = 1.0, targetGain = MAX_GAIN  (full loudness).
  //   - N equal voices at full velocity: totalRaw = N * MAX_GAIN,
  //     budgetScale = 1/N, each targetGain = MAX_GAIN/N  (shared budget).
  //   - The cubic power law still concentrates the budget on the loudest
  //     voices; quiet background voices contribute little to totalRaw and
  //     receive proportionally little gain.
  // -------------------------------------------------------------------------
  update(disp, vel) {
    if (!this.ready) return;

    // --- Pass 1: compute raw (pre-budget) gain for each voice ---
    const rawGains = new Array(vel.length).fill(0);
    let totalRaw = 0;

    for (let i = 0; i < vel.length; i++) {
      const absVel = Math.abs(vel[i]);
      if (absVel < this.SILENCE_THRESH) {
        rawGains[i] = 0;
        continue;
      }

      // Linear mapping from velocity to gain, capped at MAX_GAIN.
      const linear = Math.min(absVel / this.MAX_VEL, 1.0);

      // Power-law shaping: compresses quiet voices much more than loud ones.
      //   linear=1.0 --> rawGain = MAX_GAIN       (loudest)
      //   linear=0.5 --> rawGain = MAX_GAIN / 8   (12.5%, exponent=3)
      //   linear=0.2 --> rawGain = MAX_GAIN / 125 (barely audible)
      rawGains[i] = this.MAX_GAIN * Math.pow(linear, this.GAIN_EXPONENT);
      totalRaw += rawGains[i];
    }

    // --- Pass 2: budget normalization ---
    // If the sum of all raw gains exceeds MAX_GAIN, scale every voice down
    // proportionally.  This prevents N simultaneously-active voices from
    // stacking to N * MAX_GAIN while preserving full loudness when only
    // one voice is active.
    const budgetScale = (totalRaw > this.MAX_GAIN) ? this.MAX_GAIN / totalRaw : 1.0;

    // --- Apply gains ---
    // rampTo schedules a linear ramp over RAMP_TIME seconds.  Calling it
    // every frame at 60fps creates a chain of short ramps that smoothly
    // tracks the velocity envelope without audible zipper noise.
    for (let i = 0; i < vel.length; i++) {
      this.gains[i].gain.rampTo(rawGains[i] * budgetScale, this.RAMP_TIME);
    }
  }

  // -------------------------------------------------------------------------
  // dispose
  //
  // Stop all oscillators and free all Tone.js audio nodes.
  // Call when the observer is no longer needed (page unload, world switch).
  // -------------------------------------------------------------------------
  dispose() {
    if (!this.ready) return;

    for (let i = 0; i < this.oscs.length; i++) {
      if (this.oscs[i])  { this.oscs[i].stop(); this.oscs[i].dispose(); }
      if (this.gains[i]) { this.gains[i].dispose(); }
    }
    if (this.bus) this.bus.dispose();

    this.ready = false;
  }
}
