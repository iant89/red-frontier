import './style.css';
import './ui/menuTheme.css';
import { LoadingScreen, nextFrame, delay } from './ui/LoadingScreen';
import { Game } from './app/Game';

/**
 * Boot sequence: the splash covers module load with honest staged progress,
 * then the Game (and its main menu) takes over.
 */
async function boot(): Promise<void> {
  const splash = new LoadingScreen({
    kicker: 'Ares Expeditionary Command',
    title: 'RED FRONTIER',
    steps: [
      'Contacting mission control',
      'Loading interface systems',
      'Surveying saved colonies',
      'Calibrating renderer',
    ],
  });
  splash.mount();
  try {
    splash.setActiveStep(0);
    splash.setProgress(0.06, 'Contacting mission control…');
    await nextFrame();
    await delay(180);

    splash.setActiveStep(1);
    splash.setProgress(0.3, 'Loading interface systems…');
    await nextFrame();
    // Touch storage early so a denied/quota'd jar fails here, not mid-save.
    try {
      localStorage.setItem('red-frontier-probe', '1');
      localStorage.removeItem('red-frontier-probe');
    } catch {
      /* private mode — the game runs, saves just won't persist */
    }
    await delay(160);

    splash.setActiveStep(2);
    splash.setProgress(0.58, 'Surveying saved colonies…');
    await nextFrame();
    await delay(160);

    splash.setActiveStep(3);
    splash.setProgress(0.82, 'Calibrating renderer…');
    await nextFrame();

    // The Game builds the HUD and raises the main menu behind the splash.
    new Game();

    splash.markAllDone();
    splash.setProgress(1, 'All systems nominal.');
    await delay(280);
  } catch (err) {
    console.error(err);
    splash.setProgress(1, 'Could not start — this build needs WebGL2 enabled.');
    await delay(2600);
    return;
  } finally {
    splash.unmount();
  }
}

// Ensure the DOM (#app, #game-canvas) is present before wiring up.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot());
} else {
  void boot();
}
