/* assets/js/theme-toggle.js */
(() => {
  const STORAGE_KEY = "theme";
  const THEME_DARK = "dark";
  const THEME_LIGHT = "light";

  const applyTheme = (theme) => {
    const root = document.documentElement;
    if (theme === THEME_DARK) {
      root.setAttribute("data-theme", THEME_DARK);
    } else {
      root.removeAttribute("data-theme");
    }

    const btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.setAttribute(
        "aria-label",
        theme === THEME_DARK ? "Switch to light theme" : "Switch to dark theme"
      );
      btn.innerHTML = theme === THEME_DARK ? "🌞" : "🌙";
    }
  };

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    applyTheme(saved);
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(prefersDark ? THEME_DARK : THEME_LIGHT);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const current = document.documentElement.getAttribute("data-theme") === THEME_DARK
        ? THEME_DARK
        : THEME_LIGHT;
      const next = current === THEME_DARK ? THEME_LIGHT : THEME_DARK;
      applyTheme(next);
      localStorage.setItem(STORAGE_KEY, next);
    });
  });
})();
