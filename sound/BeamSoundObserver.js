/**
 * BeamSoundObserver.js
 *
 * Responsibility:
 *   Modal additive synthesis for the beam world -- two wave types, all mono.
 *   Bending oscillators driven by bending modal energies.
 *   Extensional oscillators driven by extensional modal energies.
 *   Transient noise bursts on strike events (different character for side vs. end).
 *
 * NOT allowed to:
 *   Modify bendingDef, extensionalDef, bendingState, or extensionalState.
 *   Advance physics time.
 *   Do hit-testing or rendering.
 *
 * -------------------------------------------------------------------
 * Signal chain per bending mode n (12 modes):
 *
 *   BendOsc_n  (sine, f = omega_bend_n / (2*pi) * AUDIO_SCALE)
 *     --> BendGain_n  (0..MAX_GAIN_BEND, driven by sqrt(energy_n) each frame)
 *     --> BendBus     (Tone.Gain)
 *     --> Tone.Destination
 *
 * Signal chain per extensional mode n (8 modes):
 *
 *   ExtOsc_n   (sine, f = omega_ext_n / (2*pi) * AUDIO_SCALE)
 *     --> ExtGain_n   (0..MAX_GAIN_EXT, driven by sqrt(energy_n) each frame)
 *     --> ExtBus      (Tone.Gain)
 *     --> Tone.Destination
 *
 * Side-strike transient (bending knock):
 *
 *   NoiseSynth_side  (white, fast envelope)
 *     --> Filter_side  (lowpass ~1800 Hz -- dull wooden knock)
 *     --> BendBus
 *
 * End-strike transient (extensional ping):
 *
 *   NoiseSynth_end   (white, fast envelope)
 *     --> Filter_end   (highpass ~3500 Hz -- bright metallic ping)
 *     --> ExtBus
 *
 * -------------------------------------------------------------------
 * AUDIO_SCALE = 100 for both wave types.
 *
 * With the visual slow-motion physics (E=7.4e7, rho=7800, h=0.02, L=1m):
 *   Bending fundamental:
 *     c_bend = sqrt(EI/(rho*A)) = 0.562 m^2/s
 *     f1_bend = (4.73/L)^2 * c_bend / (2*pi) = 2.00 Hz (visual)
 *     f1_bend_audio = 2.00 * 100 = 200 Hz  (G3)
 *   Extensional fundamental:
 *     c_ext = sqrt(E/rho) = 97.4 m/s
 *     f1_ext = c_ext / (2*L) = 48.7 Hz (visual)
 *     f1_ext_audio = 48.7 * 100 = 4870 Hz  (bright metallic ping)
 *
 * Bending spectrum (dispersive, n^2 scaling):
 *   n=1: 200 Hz, n=2: 552 Hz, n=3: 1080 Hz, n=4: 1812 Hz, ...
 * Extensional spectrum (harmonic):
 *   n=1: 4870 Hz, n=2: 9740 Hz, ... (only n=1 is audible)
 *
 * The dispersive bending spectrum gives the characteristic inharmonic
 * metallic ring of a struck bar (xylophone, glockenspiel, marimba).
 * The extensional ping is a bright transient at the start of end-strikes.
 *
 * -------------------------------------------------------------------
 * Gain formula per mode n each frame:
 *
 *   amplitude_n = sqrt(energy_n)
 *   raw_n       = clamp(amplitude_n / REF_AMP, 0, 1)
 *   target_n    = MAX_GAIN * raw_n^GAIN_EXPONENT
 *
 * GAIN_EXPONENT=2: quieter modes are suppressed relative to loud modes.
 * Modes at half the reference amplitude contribute only 1/4 of MAX_GAIN.
 *
 * -------------------------------------------------------------------
 * Frequency change detection:
 *
 * If L, E, rho, or h changes (future slider: length, material preset),
 * bendingDef.omega or extensionalDef.omega will be replaced (new array
 * reference). update() detects this and ramps oscillator frequencies
 * to match without rebuilding the audio graph.
 *
 * -------------------------------------------------------------------
 * ensureAudioGraph() must be called from a user gesture (mousePressed or
 * keyPressed) to satisfy the browser autoplay policy. Safe to call multiple
 * times -- exits immediately if this.ready is already true.
 */

class BeamSoundObserver {

  /**
   * @param {BeamBendingDefinition}    bendingDef    -- read-only; N_elastic bending modes
   * @param {BeamExtensionalDefinition} extensionalDef -- read-only; N_elastic ext. modes
   */
  constructor(bendingDef, extensionalDef) {
    this.bendingDef    = bendingDef;
    this.extensionalDef = extensionalDef;

    // Mode counts for each wave type.
    this.N_bend = bendingDef.N;       // elastic bending modes (12 default)
    this.N_ext  = extensionalDef.N;   // elastic extensional modes (8 default)

    // AUDIO_SCALE: multiply physics frequency (Hz) by this to get audible frequency.
    // Same value for both wave types so the pitch relationship is physically correct:
    //   bending f1 ~ 200 Hz, extensional f1 ~ 4870 Hz.
    this.AUDIO_SCALE = 100;

    // --- Readiness and mute ---
    this.ready   = false;
    this.isMuted = false;

    // --- Tone.js node arrays (null until ensureAudioGraph runs) ---
    // bendOscs[n]   : Tone.Oscillator -- bending mode n sine wave
    // bendGains[n]  : Tone.Gain       -- amplitude driven by bending energy
    // extOscs[n]    : Tone.Oscillator -- extensional mode n sine wave
    // extGains[n]   : Tone.Gain       -- amplitude driven by extensional energy
    // bendBus       : Tone.Gain       -- bending master bus
    // extBus        : Tone.Gain       -- extensional master bus
    // noiseSide     : Tone.NoiseSynth -- side-strike knock transient
    // filterSide    : Tone.Filter     -- lowpass shaping for side knock
    // noiseEnd      : Tone.NoiseSynth -- end-strike ping transient
    // filterEnd     : Tone.Filter     -- highpass shaping for end ping
    this.bendOscs  = new Array(this.N_bend).fill(null);
    this.bendGains = new Array(this.N_bend).fill(null);
    this.extOscs   = new Array(this.N_ext).fill(null);
    this.extGains  = new Array(this.N_ext).fill(null);
    this.bendBus   = null;
    this.extBus    = null;
    this.noiseSide   = null;
    this.filterSide  = null;
    this.noiseEnd    = null;
    this.filterEnd   = null;

    // --- Bending gain parameters ---
    // 12 bending oscillators. At MAX_GAIN_BEND=0.10, worst-case correlated sum
    // = 12 * 0.10 = 1.20. In practice power-law shaping keeps only 3-5 modes
    // loud at once, so effective peak < 0.50.
    this.MAX_GAIN_BEND = 0.07;

    // REF_AMP_BEND: sqrt(energy) value mapped to MAX_GAIN_BEND (pre-power-law).
    // Bending modes after a center strike (v0=5 m/s): sqrt(energy) ~ 0.1-0.8.
    // REF_AMP = 0.4 maps the strongest bending modes near full gain.
    this.REF_AMP_BEND = 0.4;

    // --- Extensional gain parameters ---
    // 8 extensional oscillators. Frequencies are very high (f1 ~ 4870 Hz);
    // only the lowest 1-2 are musically significant. Keep gain modest.
    this.MAX_GAIN_EXT = 0.06;

    // Extensional strike (v0=3 m/s, half-cosine): modal amplitudes typically
    // 0.01-0.10. REF_AMP_EXT = 0.05 maps stronger modes to near full gain.
    this.REF_AMP_EXT = 0.05;

    // Power-law shaping shared by both groups.
    this.GAIN_EXPONENT = 2;

    // Silence threshold: energy below this value is treated as exactly zero.
    this.SILENCE_THRESH = 1e-8;

    // Gain ramp duration (seconds). 50ms smooths 60fps envelope updates.
    this.RAMP_TIME = 0.05;

    // Noise burst gain per strike type.
    this.NOISE_GAIN_SIDE = 0.30;   // side knock: moderate level
    this.NOISE_GAIN_END  = 0.20;   // end ping: brighter but shorter

    // --- Audio-domain decay multiplier ---
    // Applied on top of the physics-energy-driven gain to shorten the audible
    // decay independently of structural damping. This models materials like wood
    // whose acoustic radiation efficiency is much higher than structural zeta alone
    // would suggest -- energy radiates away very quickly even if the beam still
    // vibrates structurally.
    //
    // _audioDecayMult: current multiplier, 1.0 = full gain, 0.0 = silent.
    // _audioDecayPerFrame: multiplicative factor applied each frame.
    //   1.0 = no extra audio decay (metal, glass).
    //   0.90 = decays to ~5% after 27 frames (0.45s at 60fps) -- fast wood decay.
    // Reset to 1.0 on each triggerStrike() so each strike starts at full gain.
    this._audioDecayMult     = 1.0;
    this._audioDecayPerFrame = 1.0;

    // --- Frequency change detection ---
    // Store last omega array references seen by update().
    // New array reference (from recompute()) triggers oscillator retune.
    this._lastBendOmega = null;
    this._lastExtOmega  = null;
  }

  // -----------------------------------------------------------------------
  // ensureAudioGraph
  //
  // Build the Tone.js signal chain. Must be called from a user gesture
  // (mousePressed, keyPressed) to satisfy the browser autoplay policy.
  // Safe to call multiple times -- exits immediately if already ready.
  //
  // Graph structure after this call:
  //   bendOscs[n] --> bendGains[n] --> bendBus --> Destination
  //   extOscs[n]  --> extGains[n]  --> extBus  --> Destination
  //   noiseSide --> filterSide --> bendBus
  //   noiseEnd  --> filterEnd  --> extBus
  // -----------------------------------------------------------------------
  async ensureAudioGraph() {
    if (this.ready) return;

    // Resume AudioContext if suspended (needed on iOS/Safari and first gesture).
    if (Tone.context.state !== 'running') {
      await Tone.start();
    }

    // --- Bending bus ---
    // Master gain for all bending voices. Default 0.85 leaves headroom.
    this.bendBus = new Tone.Gain(0.85).toDestination();

    // --- Extensional bus ---
    // Separate bus so bending and extensional levels can be adjusted independently.
    // Extensional frequencies are very high; keep slightly quieter than bending.
    this.extBus = new Tone.Gain(0.70).toDestination();

    // --- Build bending oscillators (12 elastic modes) ---
    const bendOmega = this.bendingDef.omega;
    for (let n = 0; n < this.N_bend; n++) {
      // Audible frequency: physics_Hz * AUDIO_SCALE.
      // omega[n] is in rad/s; divide by 2*pi for Hz.
      const physHz  = bendOmega[n] / (2 * Math.PI);
      const audioHz = Math.max(physHz * this.AUDIO_SCALE, 20);   // floor at 20 Hz

      const osc  = new Tone.Oscillator({ frequency: audioHz, type: 'sine' });
      const gain = new Tone.Gain(0);   // start silent; update() ramps this each frame

      osc.connect(gain);
      gain.connect(this.bendBus);
      osc.start();

      this.bendOscs[n]  = osc;
      this.bendGains[n] = gain;
    }

    // --- Build extensional oscillators (8 elastic modes) ---
    const extOmega = this.extensionalDef.omega;
    for (let n = 0; n < this.N_ext; n++) {
      const physHz  = extOmega[n] / (2 * Math.PI);
      const audioHz = Math.max(physHz * this.AUDIO_SCALE, 20);

      const osc  = new Tone.Oscillator({ frequency: audioHz, type: 'sine' });
      const gain = new Tone.Gain(0);

      osc.connect(gain);
      gain.connect(this.extBus);
      osc.start();

      this.extOscs[n]  = osc;
      this.extGains[n] = gain;
    }

    // --- Side-strike transient: lowpass-filtered noise (dull knock) ---
    // A soft wooden/rubber mallet striking the side of a metal bar.
    // Lowpass at ~1800 Hz removes bright hiss; the thump reads as a mallet impact.
    this.noiseSide = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: {
        attack:  0.002,   // 2ms attack = immediate percussive onset
        decay:   0.040,   // 40ms decay = medium-length knock
        sustain: 0,       // no sustain -- sharp impact, not continuous noise
        release: 0.04     // clean release
      }
    });
    this.filterSide = new Tone.Filter(1800, 'lowpass');
    this.noiseSide.connect(this.filterSide);
    this.filterSide.connect(this.bendBus);
    this.noiseSide.volume.value = Tone.gainToDb(this.NOISE_GAIN_SIDE);

    // --- End-strike transient: highpass-filtered noise (bright metallic ping) ---
    // A hard hammer striking the end face of a metal rod.
    // Highpass at ~3500 Hz retains the bright click; the ring of the metal bar
    // then comes from the extensional oscillators building up over the next frames.
    this.noiseEnd = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: {
        attack:  0.001,   // 1ms attack = very sharp onset
        decay:   0.020,   // 20ms decay = short bright click
        sustain: 0,
        release: 0.02
      }
    });
    this.filterEnd = new Tone.Filter(3500, 'highpass');
    this.noiseEnd.connect(this.filterEnd);
    this.filterEnd.connect(this.extBus);
    this.noiseEnd.volume.value = Tone.gainToDb(this.NOISE_GAIN_END);

    // Cache initial omega references for change detection.
    this._lastBendOmega = bendOmega;
    this._lastExtOmega  = extOmega;

    this.ready = true;
  }

  // -----------------------------------------------------------------------
  // update
  //
  // Called every draw() frame. Two jobs:
  //   1. Detect frequency changes (omega array replaced by recompute()) and
  //      retune oscillators without rebuilding the audio graph.
  //   2. Drive oscillator gains from current modal energies.
  //
  // @param {number[]} bendingEnergies    -- per-mode energies for bending (length N_bend)
  // @param {number[]} extensionalEnergies -- per-mode energies for extensional (length N_ext)
  // -----------------------------------------------------------------------
  update(bendingEnergies, extensionalEnergies) {
    if (!this.ready) return;

    // --- Detect bending frequency change ---
    // bendingDef.omega is replaced by recompute() (new array reference).
    if (this.bendingDef.omega !== this._lastBendOmega) {
      this._retuneBending(this.bendingDef.omega);
      this._lastBendOmega = this.bendingDef.omega;
    }

    // --- Detect extensional frequency change ---
    if (this.extensionalDef.omega !== this._lastExtOmega) {
      this._retuneExtensional(this.extensionalDef.omega);
      this._lastExtOmega = this.extensionalDef.omega;
    }

    // --- Advance audio-domain decay multiplier ---
    // Wood (and similar materials) use _audioDecayPerFrame < 1.0 so the audio
    // fades out faster than the physics energies alone would produce.
    // For metal and glass, _audioDecayPerFrame = 1.0 so this is a no-op.
    this._audioDecayMult = Math.max(0, this._audioDecayMult * this._audioDecayPerFrame);

    // --- Drive bending oscillator gains ---
    for (let n = 0; n < this.N_bend; n++) {
      const e = bendingEnergies[n];

      // Guard: if energies array is shorter than expected (should not happen after
      // the R-R clamp fix, but kept as a safety net), silence the oscillator.
      if (e === undefined || e < this.SILENCE_THRESH) {
        // Schedule exact zero rather than accumulating near-zero ramps.
        this.bendGains[n].gain.rampTo(0, this.RAMP_TIME);
        continue;
      }

      // amplitude_n = sqrt(energy_n): proportional to modal displacement amplitude.
      // Scaled by _audioDecayMult: 1.0 for metal/glass, decays per-frame for wood.
      const amp    = Math.sqrt(e);
      const norm   = Math.min(amp / this.REF_AMP_BEND, 1.0);
      const target = this.MAX_GAIN_BEND * Math.pow(norm, this.GAIN_EXPONENT) * this._audioDecayMult;
      this.bendGains[n].gain.rampTo(target, this.RAMP_TIME);
    }

    // --- Drive extensional oscillator gains ---
    for (let n = 0; n < this.N_ext; n++) {
      const e = extensionalEnergies[n];

      // Guard: safety net against shorter-than-expected energies array.
      if (e === undefined || e < this.SILENCE_THRESH) {
        this.extGains[n].gain.rampTo(0, this.RAMP_TIME);
        continue;
      }

      const amp    = Math.sqrt(e);
      const norm   = Math.min(amp / this.REF_AMP_EXT, 1.0);
      const target = this.MAX_GAIN_EXT * Math.pow(norm, this.GAIN_EXPONENT) * this._audioDecayMult;
      this.extGains[n].gain.rampTo(target, this.RAMP_TIME);
    }
  }

  // -----------------------------------------------------------------------
  // triggerStrike
  //
  // Fire a transient noise burst matching the strike type.
  //   type='side' -- bending strike: lowpass-filtered knock
  //   type='end'  -- extensional strike: highpass-filtered ping
  //
  // Called from beam-sketch.js when the user performs a strike.
  // The noise burst provides immediate auditory feedback while the modal
  // oscillators build up over the first few frames.
  //
  // @param {string} type -- 'side' or 'end'
  // -----------------------------------------------------------------------
  triggerStrike(type) {
    if (!this.ready) return;

    // Reset audio decay multiplier so each strike starts at full gain.
    // For metal/glass (_audioDecayPerFrame=1.0) this has no audible effect since
    // the multiplier stays at 1.0 anyway. For wood it ensures the impact starts
    // at full amplitude and then decays quickly.
    this._audioDecayMult = 1.0;

    if (type === 'end') {
      // DISABLED: end-strike ping silenced for evaluation.
      // To re-enable, uncomment the line below.
      // this.noiseEnd.triggerAttackRelease('0.02', Tone.now());
    } else {
      // DISABLED: side-strike knock silenced for evaluation.
      // To re-enable, uncomment the line below.
      // this.noiseSide.triggerAttackRelease('0.04', Tone.now());
    }
  }

  // -----------------------------------------------------------------------
  // setAudioDecay -- set per-frame audio gain decay factor for material simulation.
  //
  // Allows wood-like materials to have fast audio decay independent of physics
  // structural damping. The multiplier _audioDecayMult starts at 1.0 on each
  // strike and is multiplied by decayPerFrame each frame.
  //
  // decayPerFrame = 1.0: no extra decay (metal, glass -- let physics drive audio).
  // decayPerFrame = 0.90: decays to ~4% in 0.5s at 60fps -- fast wood decay.
  //
  // When switching to a non-decaying material (decayPerFrame >= 1.0), the
  // multiplier is reset to 1.0 immediately so any residual wood decay is cleared.
  //
  // @param {number} decayPerFrame -- per-frame multiplicative factor, range [0, 1].
  // -----------------------------------------------------------------------
  setAudioDecay(decayPerFrame) {
    this._audioDecayPerFrame = Math.min(1.0, Math.max(0, decayPerFrame));
    // Immediately restore full gain when switching back to a non-decaying material.
    if (this._audioDecayPerFrame >= 1.0) {
      this._audioDecayMult = 1.0;
    }
  }

  // -----------------------------------------------------------------------
  // setMuted -- silence or unmute both buses.
  //
  // Ramps bus gains to 0 or their nominal values over 100ms to avoid clicks.
  //
  // @param {boolean} muted -- true to mute, false to unmute
  // -----------------------------------------------------------------------
  setMuted(muted) {
    this.isMuted = muted;
    if (!this.ready) return;

    const bendTarget = muted ? 0 : 0.85;
    const extTarget  = muted ? 0 : 0.70;
    this.bendBus.gain.rampTo(bendTarget, 0.1);
    this.extBus.gain.rampTo(extTarget,  0.1);
  }

  // -----------------------------------------------------------------------
  // _retuneBending -- update bending oscillator frequencies to new omega values.
  //
  // Ramps each frequency over 30ms to reduce slider-drag glitching.
  //
  // @param {number[]} omega -- new bending natural frequencies (rad/s), length N_bend
  // -----------------------------------------------------------------------
  _retuneBending(omega) {
    if (!this.ready) return;

    const RAMP = 0.03;   // 30ms frequency ramp
    for (let n = 0; n < this.N_bend; n++) {
      // Guard: omega may be shorter than N_bend if R-R produced fewer modes.
      if (n >= omega.length || !isFinite(omega[n])) continue;
      const physHz  = omega[n] / (2 * Math.PI);
      const audioHz = Math.max(physHz * this.AUDIO_SCALE, 20);
      this.bendOscs[n].frequency.rampTo(audioHz, RAMP);
    }
  }

  // -----------------------------------------------------------------------
  // _retuneExtensional -- update extensional oscillator frequencies.
  //
  // @param {number[]} omega -- new extensional natural frequencies (rad/s), length N_ext
  // -----------------------------------------------------------------------
  _retuneExtensional(omega) {
    if (!this.ready) return;

    const RAMP = 0.03;
    for (let n = 0; n < this.N_ext; n++) {
      // Guard: omega may be shorter than N_ext if R-R produced fewer modes.
      if (n >= omega.length || !isFinite(omega[n])) continue;
      const physHz  = omega[n] / (2 * Math.PI);
      const audioHz = Math.max(physHz * this.AUDIO_SCALE, 20);
      this.extOscs[n].frequency.rampTo(audioHz, RAMP);
    }
  }

  // -----------------------------------------------------------------------
  // dispose -- stop all audio nodes and free resources.
  //
  // Call when beam.html is unloaded or the observer is no longer needed.
  // -----------------------------------------------------------------------
  dispose() {
    if (!this.ready) return;

    for (let n = 0; n < this.N_bend; n++) {
      if (this.bendOscs[n])  { this.bendOscs[n].stop();  this.bendOscs[n].dispose(); }
      if (this.bendGains[n]) { this.bendGains[n].dispose(); }
    }
    for (let n = 0; n < this.N_ext; n++) {
      if (this.extOscs[n])  { this.extOscs[n].stop();  this.extOscs[n].dispose(); }
      if (this.extGains[n]) { this.extGains[n].dispose(); }
    }

    if (this.noiseSide)  this.noiseSide.dispose();
    if (this.filterSide) this.filterSide.dispose();
    if (this.noiseEnd)   this.noiseEnd.dispose();
    if (this.filterEnd)  this.filterEnd.dispose();
    if (this.bendBus)    this.bendBus.dispose();
    if (this.extBus)     this.extBus.dispose();

    this.ready = false;
  }
}
