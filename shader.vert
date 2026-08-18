#ifdef GL_ES
precision mediump float;
#endif

attribute vec3 aPosition;
attribute vec2 aTexCoord;

varying vec2 vTexCoord;

void main() {
  // p5's WebGL texture coordinates are bottom-up; flip Y once so the source
  // photograph and pointer coordinates share the browser's top-down orientation.
  vTexCoord = vec2(aTexCoord.x, 1.0 - aTexCoord.y);

  // p5 rectangle vertices arrive in 0..1 space. Expand them to the clip-space
  // quad used by the fullscreen fragment shader.
  vec4 position = vec4(aPosition, 1.0);
  position.xy = position.xy * 2.0 - 1.0;
  gl_Position = position;
}
