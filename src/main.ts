import './style.css';
import { Game } from './app/Game';

function boot(): void {
  try {
    new Game();
  } catch (err) {
    console.error(err);
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<h1>RED FRONTIER</h1>
      <div class="tag">Couldn’t start the 3D renderer. This build needs a browser with WebGL enabled (WebGL2 preferred).</div>`;
    document.getElementById('app')!.appendChild(ov);
  }
}

// Ensure the DOM (#app, #game-canvas) is present before wiring up.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
