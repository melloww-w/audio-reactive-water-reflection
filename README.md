# Water, Listening

An audio-reactive water-reflection artwork built from a frame of the source video. Music drives the water surface first; reflected light follows the changing water normals, while foreground leaves respond with a softer delay.

## Run locally

Microphone access requires a secure browser context, such as `localhost` or HTTPS.

```bash
python3 -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000), select **Enable Microphone**, and play music near the microphone. When the input becomes silent, the water, light traces, and leaves settle into a completely still frame.

## Controls

- **Microphone sensitivity** adjusts the input response.
- **Ambient motion** sets the underlying flow while sound is present.
- **Reflection distortion** changes the strength of the water refraction.
- **Highlight shimmer** controls the moving reflected-light details.
- **Bloom** adjusts the softness around bright reflections.
- **Optical dispersion** controls the subtle rainbow separation in sunlight.

## Built with

- HTML and CSS
- Vanilla JavaScript
- p5.js 2.3.1
- WebGL and GLSL fragment shaders
- Web Audio API microphone analysis

Audio is analyzed locally in the browser and is not recorded or uploaded.

