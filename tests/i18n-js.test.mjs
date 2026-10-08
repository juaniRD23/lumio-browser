// Strings Lumio builds in JavaScript (menus, toasts, dialogs, labels set by
// scripts) have Spanish too: tests/i18n.test.mjs checks the pages' static
// HTML; this checks a curated list of texts as the code renders them, with
// their values filled in, and that patterns don't leave English halves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../renderer/assets/i18n/i18n.js');
const es = require('../renderer/assets/i18n/es.js');

const c = core.compile(es);
const t = (s) => core.translate(c, s);

const EXPECTED = {
  // menus (main/menu.js, tab-strip.js, page-menu.js, devtools.js)
  'Bookmark All Tabs…': 'Agregar todas las pestañas a favoritos…',
  'Move Tabs to Another Window': 'Mover pestañas a otra ventana',
  'Docs and 3 more tabs': 'Docs y 3 pestañas más',
  'Copy Link to Highlight': 'Copiar enlace al texto destacado',
  'Open in Lumio Browser': 'Abrir en Lumio Browser',
  'Dock to Bottom': 'Acoplar abajo',
  // dialogs and toasts (main/tabs.js, caret-browsing.js, extensions.js, shortcuts.js)
  'Leave site?': '¿Quieres salir del sitio?',
  'Caret browsing is on. Press F7 to turn it off.': 'La navegación con cursor está activada. Presiona F7 para desactivarla.',
  'Another extension already uses it.': 'Otra extensión ya la usa.',
  'Use your saved card?': '¿Quieres usar tu tarjeta guardada?',
  '⌘M is used by Window › Minimize, which can’t change. Try other keys.': '⌘M lo usa Ventana › Minimizar, que no se puede cambiar. Prueba con otras teclas.',
  // window and overlays (renderer/ui)
  'Media controls · playing': 'Controles multimedia · reproduciendo',
  'Translated · show the original or change the language': 'Traducida · mostrar el original o cambiar el idioma',
  'example.com asks: Use your camera, Use your microphone': 'example.com pide: Usar tu cámara, Usar tu micrófono',
  'example.com wants to use your camera and use your microphone': 'example.com quiere usar tu cámara y usar tu micrófono',
  'Active 3 hours ago': 'Activo hace 3 horas',
  'Open tab': 'Pestaña abierta',
  // the AI panel's notes when a task ends early (main/ai/controller.js endNote)
  'Lumio stopped at its safety limit of 1000 steps. Say "continue" to keep going.': 'Lumio se detuvo en su límite de seguridad de 1000 pasos. Di "continúa" para seguir.',
  'Lumio stopped because it was repeating the same step (Hacer clic en “Siguiente”). Say "continue" to try again.': 'Lumio se detuvo porque estaba repitiendo el mismo paso (Hacer clic en “Siguiente”). Di "continúa" para intentarlo de nuevo.',
  // the autofill dropdown's announcements (renderer/ui/overlay-autofill.js)
  'Saved cards, 2. Use the arrow keys to choose and Enter to fill.': 'Tarjetas guardadas, 2. Usa las flechas para elegir y Enter para completar.',
  'Earlier entries, 12. Use the arrow keys to choose and Enter to fill.': 'Entradas anteriores, 12. Usa las flechas para elegir y Enter para completar.',
  '2 of 3': '2 de 3',
  // pages (renderer/pages)
  'Lists updated 5 min ago · 1,200 sites': 'Listas actualizadas hace 5 min · 1,200 sitios',
  'But you have 2 reused passwords and 1 weak password.': 'Pero tienes 2 contraseñas reutilizadas y 1 contraseña débil.',
  'On · encrypted on your devices · synced 5 min ago': 'Activada · cifrada en tus dispositivos · sincronizada hace 5 min',
  'New tab is back to Lumio’s shortcut.': 'Nueva pestaña volvió a la combinación de teclas de Lumio.',
  'Open all in Incognito window': 'Abrir todos en una ventana de incógnito',
};

test('texts built in JavaScript are in Spanish', () => {
  for (const [en, out] of Object.entries(EXPECTED)) assert.equal(t(en), out, en);
});
