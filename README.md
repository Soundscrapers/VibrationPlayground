# VibrationPlayground
Vibration Playground is a prototype exploring the phenomena of vibration and wave motion. The demonstrations are meant to invite interaction and play as means to gaining an intuitive understanding of the physics. Tiered menus permit those who are curious about mode shapes and other physical aspects of wave motion to explore further.

Vibration Playground is both a playable instrument and a transparent laboratory. Users disturb physical systems and observe how they evolve once released. Motion, sound, and energy transfer are treated as different views of the same underlying phenomenon—sound is not an accessory output but a first-class observable of vibration.

The project is positioned between a textbook and a musical instrument. It prioritizes physical correctness, explicit assumptions, and analytical solutions over visual spectacle or numerical black-box simulation. Every animation and sound is traceable to a well-defined physical model.

### Key Principles

1. **Time advances in exactly one place.** Physical systems respond to time; they don't own it.

2. **Modal coordinates are the truth.** Physical displacement is reconstructed on demand by summing modal contributions.

3. **Observers are read-only.** Sound and visuals observe the modal state but never modify it.

4. **Tools write to state; time never stops.** Interactions are temporary interventions while physics continues.

5. **No black boxes.** All physics uses analytical/modal solutions. No numerical PDE solvers.

## Physics

The MDOF system solves the eigenvalue problem for coupled harmonic oscillators:

```
M q̈ + C q̇ + K q = 0
```

Where:
- **M** = mass matrix (diagonal)
- **K** = stiffness matrix (ground springs + coupling springs)  
- **C** = damping matrix (modal damping assumed)

Eigenanalysis yields natural frequencies (ω) and mode shapes (Φ). Time evolution uses the analytical underdamped oscillator solution:

```
q(t) = e^(-ζωt) [q₀ cos(ωd t) + ((q̇₀ + ζωq₀)/ωd) sin(ωd t)]
```

Where `ωd = ω√(1-ζ²)` is the damped natural frequency.

## Sound Design

Sound is a perceptual scaffold for understanding vibration, not a literal sonification of eigenvalues.

- Each mode drives a tone at a fixed musical pitch (just intonation lattice from A2)
- Modal energy modulates amplitude continuously
- Higher modes have faster decay (frequency-dependent damping)
- Transient clicks occur when masses cross equilibrium

Physical modal frequencies govern time evolution; musical pitches provide a stable auditory reference frame.

## Presets

Initial conditions can be specified via `window.VIBRATION_PRESET` before loading:

```javascript
window.VIBRATION_PRESET = {
  world: 'mdof',
  mdof: {
    masses: [1, 1, 1],
    kGround: [10, 10, 10],
    coupling: [[0, 1, 30], [1, 2, 20]]
  },
  initial: {
    displacements: [0.5, 0, -0.5],
    velocities: [0, 0, 0]
  },
  sound: { muted: false }
};
```

This enables embedding multiple independent instances on a single page with different starting conditions.

## Dependencies

- [p5.js](https://p5js.org/) — Rendering and main loop
- [Tone.js](https://tonejs.github.io/) — Audio synthesis
- [math.js](https://mathjs.org/) — Linear algebra (eigenanalysis)

All loaded via CDN. No build step required.

## Development

The code is heavily commented to map directly onto vibration theory concepts. Variable names follow standard notation where possible (q for modal displacement, Φ for mode shapes, ω for natural frequency, ζ for damping ratio).

A technically trained reader (e.g., an acoustician fluent in MATLAB but not JavaScript) should be able to identify state vectors, matrices, modal coordinates, and time-stepping logic.

## Author

Created by Nicolas Sowers, an architect, sound artist, and acoustician. AI assistants (Claude, ChatGPT) were used in development.

## License

This project is licensed under the terms of the **MIT License** - see the License.md file for details.
