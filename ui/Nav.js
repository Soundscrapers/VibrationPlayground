/**
 * Nav.js -- shared navigation bar for all Vibration Playground pages.
 *
 * Runs synchronously when loaded: by the time the <script> tag at end of
 * <body> is encountered, the <nav id="vp-nav"> placeholder earlier in the
 * body is already in the DOM and ready to populate.
 *
 * Each HTML page sets the active page via a data attribute on <body>:
 *   <body data-page="mass">   (or "string", "lattice", "membrane", "beam",
 *                               "index", "about")
 *
 * World pages (mass/string/lattice/membrane/beam) get the ACCESSIBILITY
 * toggle button because they load menu.css (which styles it) and Menu.js
 * (which wires it).  Index and About pages do not.
 */

(function() {

  // Current page key from the body data attribute.
  const page = (document.body && document.body.dataset.page) || '';

  // Pages that have the sidebar and accessibility mode.
  // The ACCESSIBILITY button is only meaningful here because menu.css and
  // Menu.js are loaded on these pages and wire the body.vp-a11y toggle.
  const WORLD_PAGES = ['mass', 'string', 'lattice', 'membrane', 'beam'];
  const isWorld = WORLD_PAGES.indexOf(page) !== -1;

  // Navigation link definitions.
  // Each entry: { href, label, key }
  // key matches the data-page value used to mark the active link.
  var links = [
    { href: 'mass.html',     label: 'Mass',     key: 'mass'     },
    { href: 'string.html',   label: 'String',   key: 'string'   },
    { href: 'lattice.html',  label: 'Lattice',  key: 'lattice'  },
    { href: 'membrane.html', label: 'Membrane', key: 'membrane' },
    { href: 'beam.html',     label: 'Beam',     key: 'beam'     },
    { href: 'about.html',    label: 'About',    key: 'about'    }
  ];

  // Build link elements with active class on the current page.
  var linksHTML = links.map(function(l) {
    var cls = (l.key === page) ? ' class="active"' : '';
    return '<a href="' + l.href + '"' + cls + '>' + l.label + '</a>';
  }).join('\n      ');

  // Accessibility toggle button: world pages only.
  // Menu.js _wireA11yToggle() attaches the click handler after setup() runs.
  var a11yHTML = isWorld
    ? '\n      <button id="btn-accessible" class="nav-a11y"' +
      ' aria-label="Toggle accessibility mode">ACCESSIBILITY</button>'
    : '';

  // Helper mode toggle button: world pages only.
  // HelperMode.js _wireHelperToggle() attaches the click handler.
  var helperHTML = isWorld
    ? '\n      <button id="btn-helper" class="nav-a11y"' +
      ' aria-label="Toggle helper mode">HELPER</button>'
    : '';

  // Find the placeholder and inject content.
  var nav = document.getElementById('vp-nav');
  if (!nav) return;

  // Hamburger button: three horizontal bars, visible only on mobile (CSS handles show/hide).
  // Three <span> elements form the bars; styled entirely in site.css.
  var hamburgerHTML =
    '<button id="btn-hamburger" class="nav-hamburger"' +
    ' aria-label="Open navigation menu" aria-expanded="false">' +
    '<span></span><span></span><span></span>' +
    '</button>';

  nav.innerHTML =
    '<a href="index.html" class="nav-title">Vibration Playground</a>' +
    hamburgerHTML +
    '<div class="nav-links">' +
    '\n      ' + linksHTML + a11yHTML + helperHTML +
    '\n    </div>';

  // Wire the hamburger toggle.
  // Clicking toggles the .nav-open class on the nav, which CSS uses to
  // show/hide the .nav-links dropdown.
  var hamburger = document.getElementById('btn-hamburger');
  if (hamburger) {
    hamburger.addEventListener('click', function(e) {
      e.stopPropagation();   // prevent the document handler below from immediately closing
      var isOpen = nav.classList.toggle('nav-open');
      hamburger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
  }

  // Close the dropdown when the user taps outside the nav (e.g. on the canvas or page).
  document.addEventListener('click', function() {
    if (nav.classList.contains('nav-open')) {
      nav.classList.remove('nav-open');
      if (hamburger) hamburger.setAttribute('aria-expanded', 'false');
    }
  });

})();
